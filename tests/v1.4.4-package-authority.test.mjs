import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { foundationFixture } from './helpers/v1.4.1-fixtures.mjs';
import { authoritySeconds, createAuthorityResolver, readLifecycleActorFacts, readFinancialHistoryActorFacts, compileAuthorityAssertions } from '../src/v1.4.1/authority-resolver.mjs';
import { buildStarsInvoicePayload, selectServerPrice } from '../src/v1.3.6/stars-core-foundation.mjs';
import { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../src/v1.3.6/stars-access-runtime.mjs';
import { PACKAGE_CONTRACT_VERSION, PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES,
  readPackageContractConfig, normalizeServerPackagePrice, selectServerPackagePrice,
  resolveOwnPackagePeriodAuthority, readVerifiedPackagePeriods, compilePackagePeriodAssertions,
  projectPackagePaidBoundary, createServerPackageQuote, createServerMonthlyTransitionQuote,
  assertPackageQuoteAdmissible, assertRecurringExitConfirmed, monthlyTransitionEligibility,
  planScheduledPackageTransition, cancelScheduledPackageTransition } from '../src/v1.4.4/package-contract.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const stamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
const resolver = createAuthorityResolver();
let sequence = 1442000;
const rejected = (fn, code) => assert.throws(fn, error => error.code === code);
const rejectedAsync = (fn, code) => assert.rejects(fn, error => error.code === code);

function fixture(t, patch = {}) {
  const f = foundationFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql', '0072-v1.4.4-package-contract.sql',
    '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, STARS_PAYMENTS_ENABLED: 'true', STARS_BILLING_MODE: 'prepaid',
    STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1', STARS_RECURRING_ENABLED: 'true',
    STARS_INVOICE_SECRET: 'synthetic-v144-offline-only-secret-longer-than-thirty-two-characters',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '900',
    STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true', ...patch };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS))
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
      plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds,
      f.serverEnv.STARS_TERMS_REVISION, f.now - 10000, f.now - 10000);
  for (const actorId of [101, 900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(actorId);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(actorId);
  }
  return f;
}
async function own(f, actorId = 900) {
  const actor = await resolver.resolveActor(await f.context(actorId, 'access.read_own'));
  const verifiedPackagePeriods = await resolveOwnPackagePeriodAuthority({ actor, nowSec: f.now });
  return { actor, verifiedPackagePeriods, nowSec: f.now };
}
const quote = (scope, plan = 'professional', code = '3m') => createServerPackageQuote({ ...scope,
  request: { requestedPlanCode: plan, packageCode: code } });

async function seedOrder(f, { plan = 'professional', mode = 'prepaid', days = 30, createdAt = f.now - 100,
  prepaidState = 'precheckout_ok' } = {}) {
  const price = f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(`${plan}-${days}d-${mode}-v1`);
  await acceptStarsPurchaseTerms({ ...f.serverEnv, STARS_TERMS_REVISION: price.terms_revision },
    { telegramId: 900, telegramUpdateId: ++sequence, acceptedAt: createdAt - 1 });
  const orderId = crypto.randomUUID();
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: 900, priceId: price.price_id });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,
    currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,
    expires_at,precheckout_approved_at,updated_at) VALUES(?,900,?,1,?,'XTR',?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, price.price_id, plan, price.amount_stars, price.access_seconds, mode, price.terms_revision,
      payload, prepaidState, createdAt, f.now + 600, prepaidState === 'precheckout_ok' ? createdAt + 1 : null, createdAt + 1);
  return { orderId, payload, price, createdAt };
}
async function seedCurrent(f, { plan = 'professional', mode = 'prepaid' } = {}) {
  const order = await seedOrder(f, { plan, mode });
  if (mode === 'recurring') {
    const acceptance = f.sqlite.prepare('SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=900 AND terms_revision=?')
      .get(order.price.terms_revision);
    order.contractId = crypto.randomUUID();
    f.sqlite.prepare(`INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,
      origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,
      billing_mode,period_seconds,currency,amount_stars,created_at,updated_at)
      VALUES(?,900,?,?,?,?,?,?,?,'recurring',2592000,'XTR',?,?,?)`).run(order.contractId, plan,
      order.price.price_id, order.orderId, order.payload, hash(order.payload), order.price.terms_revision,
      acceptance.acceptance_id, order.price.amount_stars, order.createdAt, order.createdAt);
  }
  const paidAt = f.now - 10, end = paidAt + 2592000;
  const recorded = await recordStarsSuccessfulPayment(f.serverEnv, { update_id: ++sequence, message: {
    message_id: ++sequence, date: paidAt, from: { id: 900, is_bot: false }, chat: { id: 900, type: 'private' },
    successful_payment: { currency: 'XTR', total_amount: order.price.amount_stars, invoice_payload: order.payload,
      telegram_payment_charge_id: 'synthetic-v144-monthly-' + sequence, provider_payment_charge_id: '',
      ...(mode === 'recurring' ? { is_recurring: true, is_first_recurring: true, subscription_expiration_date: end } : {}) } } },
  { receivedAt: paidAt });
  const applied = await applyStarsPaidAccess(f.serverEnv, { orderId: recorded.orderId, appliedAt: paidAt });
  assert.equal(applied.accessApplied, true);
  return { ...order, recorded, applied, paidAt, end };
}

// Explicitly synthetic future facts in an isolated SQLite database. Part 2
// supplies the genuine webhook producer; this helper does not assert one ran.
async function seedFuture(f, offered, { paidAt = f.now, start = Math.max(offered.quotedStartsAt, paidAt),
  opaqueCharge = 'synthetic-v144-package-charge-' + ++sequence, reasonCode = 'successful_payment' } = {}) {
  const order = await seedOrder(f, { plan: offered.planCode, days: offered.durationDays,
    createdAt: offered.createdAt, prepaidState: 'created' });
  const data = { order_id: order.orderId, telegram_id: 900, contract_version: offered.contractVersion,
    package_code: offered.packageCode, duration_days: offered.durationDays, period_seconds: offered.periodSeconds,
    price_id: offered.priceId, price_version: offered.priceVersion, plan_code: offered.planCode,
    billing_mode: offered.billingMode, currency: offered.currency, amount_stars: offered.amountStars,
    offer_version: offered.offerVersion, campaign_code: offered.campaignCode,
    quoted_starts_at: offered.quotedStartsAt, quoted_ends_at: offered.quotedEndsAt,
    source_subscription_id: offered.sourceSubscriptionId, source_package_period_id: offered.sourcePackagePeriodId,
    source_paid_until: offered.sourcePaidUntil, source_revision: offered.sourceRevision,
    source_payment_ledger_entry_id: offered.sourcePaymentLedgerEntryId, source_fingerprint: offered.sourceFingerprint,
    transition_id: null, created_at: offered.createdAt };
  f.sqlite.prepare(`INSERT INTO subscription_package_orders(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(() => '?').join(',')})`)
    .run(...Object.values(data));
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?")
    .run(f.now, f.now, order.orderId);
  const ledgerId = 'synthetic-v144-paid-' + crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,
    direction,currency,amount_stars,telegram_payment_charge_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,900,'payment','credit','XTR',? ,?,?,?,?)`)
    .run(ledgerId, 'synthetic-v144-ledger:' + ledgerId, order.orderId, offered.amountStars, opaqueCharge, reasonCode, paidAt, paidAt);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='paid',paid_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?")
    .run(paidAt, paidAt, order.orderId);
  const periodId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_package_periods(period_id,order_id,payment_ledger_entry_id,telegram_id,
    plan_code,price_id,price_version,billing_mode,starts_at,ends_at,period_seconds,recorded_at)
    VALUES(?,?,?,900,?,?,1,'prepaid',?,?,?,?)`).run(periodId, order.orderId, ledgerId,
      offered.planCode, offered.priceId, start, start + offered.periodSeconds, offered.periodSeconds, paidAt);
  f.sqlite.prepare("UPDATE subscription_orders SET order_state='applied',applied_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?").run(paidAt,paidAt,order.orderId);
  return { ...order, periodId, ledgerId, paidAt, start, end: start + offered.periodSeconds, opaqueCharge };
}

function cancellation(f, current, { state = 'confirmed' } = {}) {
  const contract = f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(current.contractId);
  const commandId = crypto.randomUUID(), eventId = crypto.randomUUID();
  f.sqlite.prepare(`INSERT INTO subscription_provider_commands(command_id,idempotency_key,contract_id,telegram_id,
    action,desired_auto_renew,expected_contract_revision,first_payment_ledger_entry_id,request_sha256,created_at,updated_at)
    VALUES(?,?,?,900,'cancel_renewal',0,?,?,?,?,?)`).run(commandId, 'synthetic-v144-cancel:' + commandId,
      current.contractId, contract.revision, contract.first_payment_ledger_entry_id, hash('synthetic cancellation'), f.now, f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state='attempted',attempted_count=1,attempted_at=?,revision=revision+1,
    updated_at=? WHERE command_id=?`).run(f.now, f.now, commandId);
  f.sqlite.prepare(`INSERT INTO subscription_provider_events(event_id,event_key,contract_id,command_id,telegram_id,
    event_type,source,actor_type,reason_code,evidence_sha256,received_at) VALUES(?,?,?,?,900,?,?,'system',?,?,?)`)
    .run(eventId, 'synthetic-v144-ack:' + commandId, current.contractId, commandId,
      state === 'confirmed' ? 'command_confirmed' : 'command_unknown', state === 'confirmed' ? 'provider_response' : 'system',
      state === 'confirmed' ? 'telegram_command_acknowledged' : 'telegram_provider_unknown',
      hash(JSON.stringify([commandId, 'cancel_renewal', state, ''])), f.now);
  f.sqlite.prepare(`UPDATE subscription_provider_commands SET state=?,acknowledgement_event_id=?,revision=revision+1,
    updated_at=? WHERE command_id=?`).run(state, state === 'confirmed' ? eventId : null, f.now, commandId);
  return { commandId, eventId };
}


import { createRuntimeAuthorizer, projectRuntimeAccessAuthority, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { projectSubscriptionAccess } from '../src/v1.4.2/subscription-access.mjs';
import { readVerifiedLifecycleFacts } from '../src/v1.4.3/lifecycle-authority.mjs';

async function runtime(f,id=900) {
 const context=await f.context(id,'access.read_own');
 const authorization=await createRuntimeAuthorizer().authorize(context);
 await assertRuntimeAuthorizationFresh(authorization);
 return {authorization,access:projectSubscriptionAccess(authorization),capabilities:projectRuntimeAccessAuthority(authorization)};
}
async function guards(f,actor,expected=1) {
 for (const part of compileAuthorityAssertions(actor).assertions) {
  assert.ok(part.params.length<=99);
  const result=await f.binding.prepare(`SELECT (${part.sql}) AS allowed`).bind(...part.params).first();
  if (expected===1) assert.equal(result.allowed,1,part.sql);
  else if (result.allowed!==1) return;
 }
 if(expected!==1) assert.fail('all captured assertions remained valid');
}
function refund(f,period) {
 const id='synthetic-package-refund-'+crypto.randomUUID();
 f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,direction,currency,amount_stars,telegram_payment_charge_id,related_ledger_entry_id,reason_code,occurred_at,recorded_at) VALUES(?,?,?,900,'refund','debit','XTR',?,?,?,'owner_requested_refund',?,?)`).run(id,'synthetic-refund:'+id,period.orderId,period.price.amount_stars,period.opaqueCharge,period.ledgerId,f.now,f.now);
 return id;
}

test('real resolver and runtime switch Professional to paid Dragon exactly at boundary without projection writes',async t=>{
 const f=fixture(t),monthly=await seedCurrent(f),future=await seedFuture(f,quote(await own(f),'dragon'));
 const rawBefore=JSON.stringify(f.sqlite.prepare('SELECT * FROM user_plans WHERE telegram_id=900').get());
 const actorBefore=(await own(f)).actor;
 await guards(f,actorBefore);
 let view=await runtime(f);
 assert.equal(view.capabilities.planCode,'professional');assert.equal(view.capabilities.paidCapabilitiesEnabled,true);
 assert.equal(view.access.current.expiresAt,monthly.end);
 f.now=monthly.end-1;view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');
 f.now=monthly.end;await guards(f,actorBefore,0);
 f.binding.audit.length=0;view=await runtime(f);
 assert.equal(view.capabilities.planCode,'dragon');assert.equal(view.capabilities.paidCapabilitiesEnabled,true);
 assert.equal(view.access.current.sourceKind,'package_payment');assert.equal(view.access.current.startsAt,future.start);
 assert.equal(view.access.current.expiresAt,future.end);assert.equal(view.access.current.activeDragon,true);
 assert.ok(f.binding.audit.every(row=>row.mode==='read'&&row.sql.startsWith('SELECT ')));
 assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM user_plans WHERE telegram_id=900').get()),rawBefore);
 f.now=future.end;view=await runtime(f);assert.equal(view.capabilities.planCode,'free');assert.equal(view.capabilities.paidCapabilitiesEnabled,false);
});

test('multiple mixed-plan paid packages preserve dates, current source and receipt history across all boundaries',async t=>{
 const f=fixture(t),first=await seedFuture(f,quote(await own(f),'professional'));
 const second=await seedFuture(f,quote(await own(f),'dragon'));
 const third=await seedFuture(f,quote(await own(f),'professional'));
 assert.equal(second.start,first.end);assert.equal(third.start,second.end);
 let view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.expiresAt,first.end);
 f.now=second.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'dragon');assert.equal(view.access.current.expiresAt,second.end);
 f.now=third.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.expiresAt,third.end);
 const actor=(await own(f)).actor,facts=readVerifiedLifecycleFacts(readLifecycleActorFacts(actor));
 assert.equal(facts.periods.length,3);assert.equal(new Set(facts.periods.map(row=>row.subscriptionId)).size,3);
 const history=readFinancialHistoryActorFacts(actor);assert.equal(history.entries.length,3);
 assert.ok(history.entries.every(row=>row.status==='paid'&&row.reviewRequired===false));
 assert.ok(history.entries.some(row=>row.paidPeriod.startsAt===second.start&&row.paidPeriod.endsAt===second.end));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS count FROM subscription_access_grants').get().count,0);
});

test('exact future package refund excludes only that interval and leaves independent later dates intact',async t=>{
 const f=fixture(t),first=await seedFuture(f,quote(await own(f),'professional'));
 const second=await seedFuture(f,quote(await own(f),'dragon'));
 const third=await seedFuture(f,quote(await own(f),'professional'));
 const immutableBefore=JSON.stringify(f.sqlite.prepare('SELECT * FROM subscription_package_periods ORDER BY starts_at').all());
 const actor=(await own(f)).actor;refund(f,second);await guards(f,actor,0);
 let view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.expiresAt,first.end);
 f.now=second.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'free');assert.equal(view.capabilities.paidCapabilitiesEnabled,false);
 f.now=third.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.expiresAt,third.end);
 assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM subscription_package_periods ORDER BY starts_at').all()),immutableBefore);
 const entries=readFinancialHistoryActorFacts((await own(f)).actor).entries;
 assert.equal(entries.find(row=>row.ledgerEntryId===second.ledgerId).status,'refunded');
 assert.equal(entries.find(row=>row.ledgerEntryId===third.ledgerId).status,'paid');
});

test('refund of current package cannot grant a later paid tariff early or compact it into the gap',async t=>{
 const f=fixture(t),first=await seedFuture(f,quote(await own(f),'professional')),second=await seedFuture(f,quote(await own(f),'dragon'));
 refund(f,first);let view=await runtime(f);
 assert.equal(view.capabilities.planCode,'free');assert.equal(view.capabilities.paidCapabilitiesEnabled,false);
 f.now=second.start-1;view=await runtime(f);assert.equal(view.capabilities.planCode,'free');
 f.now=second.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'dragon');assert.equal(view.access.current.startsAt,second.start);
});

test('historical paid access survives purchase flags being disabled; unpaid metadata grants nothing',async t=>{
 const f=fixture(t),offered=quote(await own(f),'dragon');
 const noPayment=await seedOrder(f,{plan:'dragon',days:90});
 assert.ok(noPayment.orderId);assert.equal((await runtime(f)).capabilities.planCode,'free');
 f.sqlite.prepare("UPDATE subscription_orders SET order_state='cancelled',closed_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?").run(f.now,f.now,noPayment.orderId);
 const paid=await seedFuture(f,offered);f.serverEnv.STARS_PACKAGES_ENABLED='false';f.serverEnv.STARS_PACKAGE_3M_ENABLED='false';
 const actor=await resolver.resolveActor(await f.context(900,'access.read_own'));
 assert.equal(actor.access.effectivePlan,'dragon');assert.equal(actor.access.status,'verified');await guards(f,actor);
 assert.equal((await runtime(f)).access.current.expiresAt,paid.end);
});

test('confirmed current package takes precedence over an older Dragon Preview overlay',async t=>{
 const f=fixture(t),paid=await seedFuture(f,quote(await own(f),'professional'));
 const started=f.now-100,end=started+604800,source='dragon_preview:v1.3.5-hotfix.1';
 f.serverEnv.DRAGON_PREVIEW_ENABLED='true';
 f.sqlite.prepare("INSERT INTO trial_grants(grant_id,telegram_id,subject_fingerprint,program_code,source_code,status,started_at,ends_at,retention_until,workflow_instance_id,workflow_state,granted_at,updated_at) VALUES(?,900,?,'dragon_preview',?,'active',?,?,?,?,'started',?,?)")
 .run(crypto.randomUUID(),'a'.repeat(64),source,started,end,end+86400,'synthetic-package-preview-'+ ++sequence,started,started);
 f.sqlite.prepare("UPDATE user_plans SET source_code=?,effective_from=?,effective_until=NULL,revision=revision+1 WHERE telegram_id=900").run(source,stamp(started));
 f.sqlite.prepare("UPDATE user_access_states SET access_state='trial',source_code=?,state_started_at=?,state_ends_at=?,revision=revision+1 WHERE telegram_id=900").run(source,stamp(started),stamp(end));
 f.sqlite.prepare("UPDATE user_access SET access_tier='trial',trial_used=1,trial_started_at=?,trial_ends_at=? WHERE telegram_id=900").run(stamp(started),stamp(end));
 const view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.previewActive,false);
 assert.equal(view.access.current.expiresAt,paid.end);assert.equal(view.access.current.sourceKind,'package_payment');
});

test('recurring cancelled source becomes prepaid package and a later unknown command cannot erase confirmed paid residue',async t=>{
 const f=fixture(t),monthly=await seedCurrent(f,{mode:'recurring'});cancellation(f,monthly);
 const paid=await seedFuture(f,quote(await own(f),'dragon'));
 f.now=monthly.end;let view=await runtime(f);assert.equal(view.capabilities.planCode,'dragon');
 const next=quote(await own(f),'professional');assert.equal(next.quotedStartsAt,paid.end);assert.equal(next.sourcePackagePeriodId,paid.periodId);
 const later=cancellation(f,monthly,{state:'unknown'});assert.ok(later.commandId);
 view=await runtime(f);assert.equal(view.capabilities.planCode,'dragon');assert.equal(view.capabilities.paidCapabilitiesEnabled,true);
 assert.equal(view.access.current.expiresAt,paid.end);
 const actor=await resolver.resolveActor(await f.context(900,'access.read_own'));
 await rejectedAsync(()=>resolveOwnPackagePeriodAuthority({actor,nowSec:f.now}),'package_recurring_cancellation_unconfirmed');
});

test('schema/source corruption denies commercial package authority while own access read stays protected',async t=>{
 const f=fixture(t);await seedFuture(f,quote(await own(f),'dragon'));
 const actor=(await own(f)).actor;f.sqlite.exec('DROP TRIGGER v144_package_period_no_update');await guards(f,actor,0);
 const invalid=await resolver.resolveActor(await f.context(900,'access.read_own'));
 assert.equal(invalid.financialSourceAvailable,false);assert.equal(invalid.access.effectivePlan,'free');assert.equal(invalid.access.status,'review_required');
 const view=await runtime(f);assert.equal(view.capabilities.paidCapabilitiesEnabled,false);assert.equal(view.access.current.status,'review_required');
});

test('wrong invoice secret cannot turn immutable package rows into a financial actor; copied actors remain untrusted',async t=>{
 const f=fixture(t);await seedFuture(f,quote(await own(f),'dragon'));
 const actor=(await own(f)).actor;
 assert.throws(()=>readLifecycleActorFacts(JSON.parse(JSON.stringify(actor))),{code:'untrusted_actor'});
 f.serverEnv.STARS_INVOICE_SECRET='incorrect-synthetic-package-secret-longer-than-thirty-two-characters';
 const wrong=await resolver.resolveActor(await f.context(900,'access.read_own'));
 assert.equal(wrong.access.effectivePlan,'free');assert.equal(wrong.financialSourceAvailable,false);
});

import { issueStarsPurchase, handleStarsCommerceUpdate } from '../src/v1.3.6/stars-commerce-runtime.mjs';
import { createReferralRewardCandidate } from '../src/v1.3.7/referral-reward-candidate-runtime.mjs';
import { settleReferralRewardProtection } from '../src/v1.3.7/referral-reward-protection-runtime.mjs';
import { ensureReferralBonusGrant, claimReferralBonusAccess } from '../src/v1.3.7/referral-bonus-access-runtime.mjs';

async function earnedBonus(f,{extension=false}={}) {
 Object.assign(f.serverEnv,{STARS_ROLLOUT_ALLOWLIST:'900,202',STARS_RECONCILIATION_ENABLED:'true',REFERRAL_REWARDS_ENABLED:'true',
  REFERRAL_REWARD_ROLLOUT_MODE:'public',REFERRAL_REWARD_CANDIDATES_ENABLED:'true',REFERRAL_REWARD_CONFIRMATIONS_ENABLED:'true',
  REFERRAL_BONUS_GRANTS_ENABLED:'true',REFERRAL_REWARD_PROGRAM_STARTED_AT:String(f.now-60*86400)});
 const firstStart=f.now-22*86400,at=f.now-21*86400-40;
 f.sqlite.prepare('UPDATE users SET inviter_id=900,inviter_bound_at=?,joined_at=? WHERE telegram_id=202').run(stamp(firstStart),stamp(firstStart));
 f.sqlite.prepare("INSERT INTO bot_start_events(telegram_id,source_code,is_new_user,started_at) VALUES(202,'referral',1,?)").run(stamp(firstStart));
 await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:202,telegramUpdateId:++sequence,acceptedAt:at-1});
 const calls=[],telegramApi=async(_env,method,payload)=>{calls.push({method,payload});return method==='sendInvoice'?{message_id:++sequence}:true;};
 const orderId=crypto.randomUUID(),chargeId='synthetic-earned-buyer-'+ ++sequence;
 const issued=await issueStarsPurchase(f.serverEnv,{telegramId:202,requestedPlanCode:'professional',telegramUpdateId:++sequence,orderId,createdAt:at},{telegramApi});
 const payload=calls.find(call=>call.method==='sendInvoice').payload.payload;
 const pre=await handleStarsCommerceUpdate(f.serverEnv,{update_id:++sequence,pre_checkout_query:{id:'synthetic-buyer-checkout-'+sequence,
  from:{id:202,is_bot:false},currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload}},{nowSeconds:at+1,telegramApi});assert.equal(pre.approved,true);
 const paid=await handleStarsCommerceUpdate(f.serverEnv,{update_id:++sequence,message:{message_id:++sequence,from:{id:202,is_bot:false},chat:{id:202,type:'private'},
  successful_payment:{currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload,telegram_payment_charge_id:chargeId,provider_payment_charge_id:''}}},{nowSeconds:at+2});
 assert.equal(paid.accessApplied,true,JSON.stringify(paid));
 const candidate=await createReferralRewardCandidate(f.serverEnv,{orderId,selectedAt:at+3});assert.equal(candidate.status,'created',JSON.stringify(candidate));
 const runId=crypto.randomUUID();f.sqlite.prepare("INSERT INTO payment_reconciliation_runs(run_id,run_source,status,started_at,finished_at,updated_at) VALUES(?,'scheduled','completed',?,?,?)").run(runId,candidate.confirmAfter,candidate.confirmAfter,candidate.confirmAfter);
 const ledger=f.sqlite.prepare("SELECT ledger_entry_id FROM payment_ledger WHERE order_id=? AND entry_type='payment'").get(orderId);
 f.sqlite.prepare("INSERT INTO payment_reconciliation_items(item_id,item_key,transaction_id_sha256,run_id,observation_side,transaction_direction,telegram_id,amount_stars,transaction_date,local_state,ledger_entry_id,observed_at) VALUES(?,?,?,?,'telegram','incoming',202,?,?,'matched',?,?)")
  .run(crypto.randomUUID(),'synthetic-earned-reconcile-'+ ++sequence,'a'.repeat(64),runId,issued.amountStars,at+2,ledger.ledger_entry_id,candidate.confirmAfter);
 const settled=await settleReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:runId,checkedAt:candidate.confirmAfter});assert.equal(settled.outcome,'confirmed',JSON.stringify(settled));
 const current=extension?await seedCurrent(f):null;
 const grant=await ensureReferralBonusGrant(f.serverEnv,{rewardId:candidate.rewardId,deliveredAt:f.now-4});
 if(extension) assert.equal(grant.status,'applied',JSON.stringify(grant));
 else {assert.equal(grant.status,'claimable',JSON.stringify(grant));const claimed=await claimReferralBonusAccess(f.serverEnv,{telegramId:900,bonusGrantId:grant.bonusGrantId,claimedAt:f.now});assert.equal(claimed.status,'applied',JSON.stringify(claimed));}
 return {current,grant};
}


test('genuine earned referral extension remains before future paid Dragon without losing three days',async t=>{
 const f=fixture(t),{current}=await earnedBonus(f,{extension:true});
 const offered=quote(await own(f),'dragon'),paid=await seedFuture(f,offered);
 assert.equal(offered.quotedStartsAt,current.end+259200);assert.equal(paid.start,current.end+259200);
 f.now=current.end;let view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.expiresAt,paid.start);
 f.now=paid.start-1;view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');
 f.now=paid.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'dragon');
});


test('standalone genuinely earned Professional bonus remains current until paid Dragon starts after its earned end',async t=>{
 const f=fixture(t);await earnedBonus(f);
 const before=await runtime(f);assert.equal(before.capabilities.planCode,'professional');assert.equal(before.access.current.sourceKind,'referral_bonus');
 const offered=quote(await own(f),'dragon');assert.equal(offered.quotedStartsAt,before.access.current.expiresAt);
 assert.equal(offered.sourceSubscriptionId,null);assert.equal(offered.sourcePackagePeriodId,null);
 assert.equal(offered.sourcePaidUntil,null);assert.equal(offered.sourcePaymentLedgerEntryId,null);
 const paid=await seedFuture(f,offered);let view=await runtime(f);
 assert.equal(view.capabilities.planCode,'professional');assert.equal(view.access.current.sourceKind,'referral_bonus');
 f.now=paid.start-1;view=await runtime(f);assert.equal(view.capabilities.planCode,'professional');
 f.now=paid.start;view=await runtime(f);assert.equal(view.capabilities.planCode,'dragon');assert.equal(view.access.current.sourceKind,'package_payment');
 const actor=(await own(f)).actor,facts=readVerifiedLifecycleFacts(readLifecycleActorFacts(actor));
 assert.ok(facts.periods.some(row=>row.sourceKind==='referral_bonus'&&row.ledgerEntryId.startsWith('bonus:')));
});

import { publishedOffer } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { createResourceResolver } from '../src/v1.4.1/resource-resolver.mjs';
import { can } from '../src/v1.4.1/entitlement-engine.mjs';

test('Dragon to Professional with 30 active applications keeps own records readable and denies new or resubmitted slots',async t=>{
 const f=fixture(t),first=await seedFuture(f,quote(await own(f),'dragon'));
 const second=await seedFuture(f,quote(await own(f),'professional'));
 const offer=await publishedOffer(f,202);
 for(let index=0;index<30;index++) f.sqlite.prepare("INSERT INTO lead_requests(telegram_id,offer_code,status) VALUES(900,?,'pending')")
  .run('synthetic-existing-overquota-'+index);
 const rejected=f.sqlite.prepare("INSERT INTO lead_requests(telegram_id,offer_code,status,rejection_reason) VALUES(900,?,'rejected','synthetic historical rejection')").run(offer.code);
 const rejectedId=Number(rejected.lastInsertRowid);
 const readId=f.sqlite.prepare("SELECT id FROM lead_requests WHERE telegram_id=900 AND status='pending' ORDER BY id LIMIT 1").get().id;
 const snapshot=JSON.stringify({rows:f.sqlite.prepare('SELECT * FROM lead_requests ORDER BY id').all(),history:f.sqlite.prepare('SELECT * FROM lead_request_events ORDER BY id').all()});
 async function decision(operation,ref) {
  const context=await f.context(900,operation),actor=await resolver.resolveActor(context);
  const resource=await createResourceResolver().resolve(context,actor,ref);
  return {actor,decision:can(actor,operation,resource)};
 }
 let result=await decision('application.create',{kind:'offer',key:offer.code});
 assert.equal(result.actor.access.effectivePlan,'dragon');assert.equal(result.decision.allowed,true);assert.equal(result.decision.quota.limit,50);
 f.now=second.start;assert.equal(f.now,first.end);
 result=await decision('application.create',{kind:'offer',key:offer.code});
 assert.equal(result.actor.access.effectivePlan,'professional');assert.equal(result.decision.allowed,false);
 assert.equal(result.decision.reasonCode,'quota_exceeded');assert.equal(result.decision.quota.limit,25);assert.equal(result.decision.quota.used,30);assert.equal(result.decision.actionPolicy,'read_only');
 result=await decision('application.resubmit',{kind:'application',key:rejectedId});assert.equal(result.decision.allowed,false);assert.equal(result.decision.reasonCode,'quota_exceeded');
 result=await decision('application.read_own',{kind:'application',key:readId});assert.equal(result.decision.allowed,true);
 assert.equal(JSON.stringify({rows:f.sqlite.prepare('SELECT * FROM lead_requests ORDER BY id').all(),history:f.sqlite.prepare('SELECT * FROM lead_request_events ORDER BY id').all()}),snapshot);
});


test('retained money with an artificially attached immutable period cannot acquire package access',async t=>{
 for(const reasonCode of ['package_payment_review_retained','payment_review_retained']) {
  const f=fixture(t),offered=quote(await own(f),'dragon');
  const retained=await seedFuture(f,offered,{reasonCode});
  assert.equal(f.sqlite.prepare('SELECT reason_code FROM payment_ledger WHERE ledger_entry_id=?').get(retained.ledgerId).reason_code,reasonCode);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) count FROM subscription_package_periods WHERE payment_ledger_entry_id=?').get(retained.ledgerId).count,1);
  const actor=await resolver.resolveActor(await f.context(900,'access.read_own'));
  assert.equal(actor.financialSourceAvailable,false);assert.equal(actor.access.effectivePlan,'free');assert.equal(actor.access.status,'review_required');
  assert.ok(actor.degradedTables.some(row=>row.table==='subscription_package_periods'&&row.code==='package_access_evidence_invalid'));
  const view=await runtime(f);assert.equal(view.capabilities.paidCapabilitiesEnabled,false);assert.equal(view.access.current.status,'review_required');
 }
});
