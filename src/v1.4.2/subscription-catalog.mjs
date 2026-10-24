import { readTrustedContext } from '../v1.4.1/trusted-context.mjs';
import { readRuntimeAuthorization, requireRuntimeAuthorization, projectRuntimeAccessAuthority } from '../v1.4.1/runtime-authorizer.mjs';
import { readActorFacts } from '../v1.4.1/authority-resolver.mjs';
import { STARS_CURRENCY, STARS_MONTH_SECONDS, STARS_TERMS_REVISION, STARS_INITIAL_PRICE_BOOK,
  readStarsCoreConfig, selectServerPrice } from '../v1.3.6/stars-core-foundation.mjs';
import { readV143NativeReadinessConfig, isV143NativeOwnerCheckoutEnvelope, V143_NATIVE_OWNER_CHECKOUT_FRAME,
  selectV143NativeOwnerCheckoutQuote } from '../v1.4.3/native-readiness-config.mjs';
import { readStarsRecurringConfig, STARS_RECURRING_TERMS_REVISION } from '../v1.4.3/recurring-provider-config.mjs';
import { getStarsPurchaseCatalog } from '../v1.3.6/stars-payment-runtime.mjs';
import { assertStarsPurchaseAllowed, buildStarsTermsText, buildStarsSupportText } from '../v1.3.6/stars-access-runtime.mjs';
import { getStarsRolloutDecision } from '../v1.3.6/stars-rollout.mjs';
import { projectSubscriptionComparison } from './subscription-comparison.mjs';
import { createSubscriptionSelectionUrl } from './subscription-handoff.mjs';
import { readOwnReferralDescriptor } from './referral-share.mjs';
import { readOwnDragonEmojiDescriptor } from './dragon-emoji.mjs';
import { STARS_PURCHASE_LOCK_SQL } from '../v1.4.3/payment-evidence.mjs';
import { REFUND_RETIREMENT_ACK_SQL, REFUND_RETIREMENT_FINANCIAL_SQL } from '../v1.4.3/refund-contract-lifecycle.mjs';

export const SUBSCRIPTION_CATALOG_VERSION = '2026-10-03.v1.4.2.p01';
const PLANS = Object.freeze({ free: 'Free', professional: 'Professional', dragon: 'Dragon' });
const fail = (code, status = 503) => { throw Object.assign(new Error(code), { code, status }); };
const reason = error => /^[a-z][a-z0-9_]{0,63}$/u.test(error?.code ?? '') ? error.code : 'subscription_catalog_unavailable';
const plain = value => value.replace(/<\/?(?:b|code)>/gu, '');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};

// This facade can only perform bounded SELECTs. Legacy invoice/access maintenance is never called.
function captureReads(db) {
  const captures = new Map();
  const statement = (sql, params = []) => {
    if (typeof sql !== 'string' || !/^\s*SELECT\b/iu.test(sql) || sql.includes(';') || sql.length > 8192 || params.length > 32)
      fail('subscription_catalog_write_forbidden');
    const all = async () => {
      const result = await db.prepare(sql).bind(...params).all();
      if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 128)
        fail('subscription_catalog_read_failed');
      const snapshot = JSON.stringify(result.results);
      if (snapshot.length > 65536) fail('subscription_catalog_read_failed');
      const key = JSON.stringify([sql, params]), prior = captures.get(key);
      if (prior && prior.snapshot !== snapshot) fail('subscription_catalog_stale', 409);
      captures.set(key, { sql, params, snapshot });
      if (captures.size > 16) fail('subscription_catalog_read_limit');
      return result;
    };
    return Object.freeze({ bind: (...values) => statement(sql, values), all,
      async first(column) {
        const result = await all();
        if (result.results.length > 1) fail('subscription_catalog_read_failed');
        const row = result.results[0] ?? null;
        return column ? row?.[column] ?? null : row;
      }, run: () => fail('subscription_catalog_write_forbidden') });
  };
  return Object.freeze({ binding: Object.freeze({ prepare: sql => statement(sql), batch: () => fail('subscription_catalog_write_forbidden') }),
    async assertFresh() {
      const reads = [...captures.values()];
      if (!reads.length) fail('subscription_catalog_read_failed');
      const results = await db.batch(reads.map(read => db.prepare(read.sql).bind(...read.params)));
      if (!Array.isArray(results) || results.length !== reads.length || results.some((result, index) =>
        result?.success !== true || !Array.isArray(result.results) || JSON.stringify(result.results) !== reads[index].snapshot))
        fail('subscription_catalog_stale', 409);
    } });
}

// Only a canonical own access authorization reaches this reader; request JSON cannot choose its subject or prices.
export async function readSubscriptionCatalog(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).join(',') !== 'authorization')
    fail('subscription_catalog_scope_invalid', 403);
  const { authorization } = options;
  requireRuntimeAuthorization(authorization);
  const { context, actor } = readRuntimeAuthorization(authorization), identity = readTrustedContext(context), facts = readActorFacts(actor);
  if (identity.actorKind !== 'customer' || identity.operation !== 'access.read_own'
    || facts.actorKind !== 'customer' || facts.telegramId !== identity.telegramId)
    fail('subscription_catalog_scope_invalid', 403);
  const nativeOwnerAcceptance = readV143NativeReadinessConfig()?.mode === 'owner_acceptance';
  const nativeOwnerCheckout = nativeOwnerAcceptance && isV143NativeOwnerCheckoutEnvelope(identity.env) &&
    identity.telegramId === V143_NATIVE_OWNER_CHECKOUT_FRAME.ownerId && facts.canonicalOwner;
  const now = identity.nowSeconds, subject = identity.telegramId, reads = captureReads(identity.db);
  const env = { ...identity.env, DB: reads.binding }, config = readStarsCoreConfig(env);
  const catalog = await getStarsPurchaseCatalog(env, { at: now });
  let rollout;
  try { rollout = await getStarsRolloutDecision(env, subject); }
  catch (error) { rollout = { mode: 'off', eligible: false, reason: reason(error) }; }
  const prerequisites = await reads.binding.prepare(`SELECT u.telegram_id,u.accepted_terms,u.is_blocked,
    EXISTS(SELECT 1 FROM terms_acceptances t WHERE t.telegram_id=u.telegram_id
      AND t.terms_revision=? AND t.acceptance_scope='stars_purchase') AS stars_terms_accepted
    FROM users u WHERE u.telegram_id=? LIMIT 1`).bind(config.termsRevision, subject).first();
  const orders = await reads.binding.prepare(`SELECT COUNT(*) AS count FROM subscription_orders
    WHERE telegram_id=? AND ${STARS_PURCHASE_LOCK_SQL}`).bind(subject, now).first();
  const access = projectRuntimeAccessAuthority(authorization), termsAvailable = config.termsRevision === STARS_TERMS_REVISION;
  const accepted = prerequisites?.stars_terms_accepted === 1;
  const unavailable = !prerequisites ? 'payment_user_not_found' : prerequisites.is_blocked === 1 ? 'payment_user_blocked'
    : prerequisites.accepted_terms !== 1 ? 'general_terms_not_accepted'
      : access.reviewRequired ? 'access_review_required' : !catalog.paymentsReady
        ? !catalog.paymentsEnabled ? 'stars_payments_disabled' : !catalog.catalogReady ? 'server_price_unavailable' : 'stars_payments_not_ready'
        : !rollout.eligible ? rollout.reason : !termsAvailable ? 'stars_terms_revision_not_released'
          : orders?.count > 0 ? 'payment_order_in_progress' : null;
  const offers = [{ planCode: 'free', name: PLANS.free, amountStars: 0, currency: STARS_CURRENCY,
    published: true, priceVersion: null, accessSeconds: null, billingMode: 'free', autoRenew: false,
    matchesInitialPrice: true, purchaseEligibility: { eligible: false, reasonCode: 'free_plan_no_purchase', mode: null }, checkout: null }];
  for (const planCode of ['professional', 'dragon']) {
    const price = catalog.offers.find(offer => offer.planCode === planCode);
    let purchase, reasonCode = nativeOwnerAcceptance ? 'purchase_unavailable' : unavailable;
    if (!reasonCode && price) {
      try { purchase = await assertStarsPurchaseAllowed(env, { telegramId: subject, requestedPlanCode: planCode, at: now }); }
      catch (error) { reasonCode = reason(error); }
    }
    if (!price) reasonCode ??= 'server_price_unavailable';
    const eligible = !reasonCode && purchase?.allowed === true;
    offers.push({ planCode, name: PLANS[planCode], amountStars: price?.amountStars ?? null, currency: STARS_CURRENCY,
      published: Boolean(price), priceVersion: price ? config.priceVersion : null,
      accessSeconds: price?.accessSeconds ?? null, billingMode: price?.billingMode ?? null, autoRenew: false,
      matchesInitialPrice: price ? price.amountStars === STARS_INITIAL_PRICE_BOOK[planCode].amountStars : null,
      purchaseEligibility: { eligible, reasonCode: reasonCode ?? 'eligible',
        mode: purchase?.mode ?? null, termsAcceptanceRequired: !accepted, invoiceRequiresConfirmedTerms: true },
      // This URL selects a tariff in the authenticated bot. It accepts no terms,
      // creates no invoice and never grants access in the browser.
      checkout: { available: eligible && termsAvailable, reasonCode: eligible && termsAvailable ? null : reasonCode ?? 'purchase_unavailable',
        kind: 'telegram_deep_link', url: eligible && termsAvailable ? createSubscriptionSelectionUrl(planCode) : null,
        botUsername: 'RE_Program_Bot', menuCommand: '/plans', menuCallback: 'plans',
        termsCallback: `stars_buy:${planCode}`, acceptanceCallback: `stars_accept:${planCode}`, hintIsAuthority: false } });
  }
  const recurringConfig=readStarsRecurringConfig(env);
  const recurring={enabled:recurringConfig.enabled,ready:false,billingMode:'recurring',automaticRenewal:true,
    periodSeconds:STARS_MONTH_SECONDS,priceVersion:recurringConfig.priceVersion,
    terms:{revision:recurringConfig.termsRevision,available:recurringConfig.termsRevision===STARS_RECURRING_TERMS_REVISION,
      accepted:false,scope:'stars_purchase',explicitConsentRequired:true,
      text:'Подписка продлевается автоматически каждые 30 дней за указанное количество Telegram Stars. Подтверждение относится к выбранному тарифу и этой версии условий. Будущие продления можно отменить; уже оплаченный срок сохраняется.'},offers:[]};
  if(recurringConfig.ready) {
    try {
      const prices=await reads.binding.prepare(`SELECT price_id,price_version,plan_code,currency,amount_stars,access_seconds,
        billing_mode,publication_state,terms_revision,valid_from,valid_until FROM price_book WHERE billing_mode='recurring'
        AND price_version=? AND terms_revision=? AND access_seconds=? AND plan_code IN ('professional','dragon')
        ORDER BY plan_code,price_id LIMIT 3`).bind(recurringConfig.priceVersion,recurringConfig.termsRevision,STARS_MONTH_SECONDS).all();
      if(prices.results.length!==2) fail('server_price_unavailable');
      const quotes=['professional','dragon'].map(plan=>selectServerPrice(prices.results,plan,recurringConfig,now));
      const ownTerms=await reads.binding.prepare(`SELECT COUNT(*) AS n FROM terms_acceptances WHERE telegram_id=?
        AND terms_revision=? AND acceptance_scope='stars_purchase'`).bind(subject,recurringConfig.termsRevision).first();
      const contracts=await reads.binding.prepare(`SELECT contract_id FROM subscription_billing_contracts
        WHERE telegram_id=? AND retired_at IS NULL ORDER BY contract_id LIMIT 3`).bind(subject).all();
      const retirementStage=await reads.binding.prepare(`SELECT COUNT(*) AS n FROM re_schema_migrations
        WHERE version='1.4.3-refund-contract-retirement'`).first();
      let blockingContracts=contracts.results.length;
      if(!nativeOwnerAcceptance&&retirementStage?.n===1&&blockingContracts>0&&blockingContracts<3){
        const eligible=await reads.binding.prepare(`SELECT c.contract_id FROM subscription_billing_contracts c
          WHERE c.telegram_id=? AND c.retired_at IS NULL AND ${REFUND_RETIREMENT_ACK_SQL}
          AND ${REFUND_RETIREMENT_FINANCIAL_SQL} ORDER BY c.contract_id LIMIT 3`).bind(subject,now,now).all();
        blockingContracts=contracts.results.some(row=>!eligible.results.some(candidate=>candidate.contract_id===row.contract_id))?blockingContracts:0;
      }
      recurring.terms.accepted=ownTerms?.n===1;recurring.ready=true;
      const recurringReason=!prerequisites?'payment_user_not_found':prerequisites.is_blocked===1?'payment_user_blocked':
        prerequisites.accepted_terms!==1?'general_terms_not_accepted':access.reviewRequired?'access_review_required':
        !rollout.eligible?rollout.reason:access.lifecycle?.paidAccess?'active_paid_period_present':
        ['suspended','chargeback'].includes(access.lifecycle?.state)?'paid_access_suspended':
        orders?.count>0?'payment_order_in_progress':blockingContracts?'subscription_contract_in_progress':null;
      recurring.offers=quotes.map(price=>{
        const nativeReason=!nativeOwnerAcceptance?null:!nativeOwnerCheckout?'stars_recurring_not_ready':
          !selectV143NativeOwnerCheckoutQuote(price)?'server_price_unavailable':null;
        const reasonCode=nativeReason??recurringReason;
        return {planCode:price.planCode,amountStars:price.amountStars,currency:price.currency,
          priceVersion:price.priceVersion,termsRevision:price.termsRevision,accessSeconds:price.accessSeconds,billingMode:'recurring',
          recurringConsentRequired:true,purchaseEligibility:{eligible:reasonCode===null,reasonCode:reasonCode??'eligible'},
          checkout:{available:reasonCode===null,kind:'authenticated_own_post',route:'/subscription/recurring-invoice',
            actionAdmissionRequired:true}};
      });
    }catch(error){recurring.reasonCode=reason(error);}
  }else recurring.reasonCode=recurringConfig.enabled?'stars_recurring_not_ready':'stars_recurring_disabled';
  await reads.assertFresh();
  return freeze({ version: SUBSCRIPTION_CATALOG_VERSION, generatedAt: now, priceVersion: config.priceVersion,
    termsRevision: config.termsRevision, paymentsEnabled: catalog.paymentsEnabled, paymentsReady: catalog.paymentsReady,
    catalogReady: catalog.catalogReady, problems: [...catalog.problems],
    rollout: { mode: rollout.mode, eligible: rollout.eligible, reasonCode: rollout.reason },
    billing: { mode: 'prepaid', releasedMode: config.billingMode === 'prepaid', periodSeconds: STARS_MONTH_SECONDS,
      renewal: 'manual', automaticRenewal: false }, offers, recurring,
    comparison: projectSubscriptionComparison(authorization),
    terms: { revision: config.termsRevision, publishedRevision: STARS_TERMS_REVISION, available: termsAvailable,
      accepted, scope: 'stars_purchase', acceptanceRequiredBeforeInvoice: true,
      text: termsAvailable ? plain(buildStarsTermsText(catalog)) : null, textFormat: 'plain',
      reasonCode: termsAvailable ? null : 'stars_terms_revision_not_released',
      telegramCommand: '/terms', telegramCallback: 'stars_buy:terms' },
    support: { available: true, paymentCommand: '/paysupport', paymentCallback: 'paysupport',
      url: 'https://t.me/RE_Program_Support_Bot?start=paysupport', text: plain(buildStarsSupportText(true)),
      refundTermsRevision: STARS_TERMS_REVISION, refundAutomatic: false },
    nativeDependencies: {
      referralShare: ['telegram_command','telegram_callback'].includes(identity.channel)?
        {available:false,reasonCode:'cabinet_session_required'}:readOwnReferralDescriptor(authorization),
      dragonEmoji: readOwnDragonEmojiDescriptor(authorization),
    } });
}
