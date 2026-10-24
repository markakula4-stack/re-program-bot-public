import test from 'node:test';
import './helpers/v1.4.3-p05-offline-network.mjs';
import { register } from 'node:module';
import { attachReferralCandidateAfterAppliedAccess } from '../src/v1.3.7/stars-commerce-runtime.mjs';
import {
  createPackageReferralRewardCandidate, reconcilePackageReferralRewardSourcePayment, settlePackageReferralRewardProtection,
  applyPackageReferralRewardCompensation, readPackageReferralRewardForBonus, ensurePackageReferralProtectionWorkflow,
  getPackageReferralProtectionSchedule, completePackageReferralProtectionJob, markPackageReferralProtectionJobManualReview,
  repairPackageReferralRewardProtection, resolvePackageReferralProtectionIdentity,
} from '../src/v1.4.4/package-referral-runtime.mjs';
// Isolated SQLite/D1 source fixtures; no live network, provider or database.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
const ROOT = new URL('../', import.meta.url);
const { cabinetSubscriptionFixture } = await import(new URL('tests/helpers/v1.4.3-subscription-cabinet-fixture.mjs', ROOT));
const { authoritySeconds, createAuthorityResolver } = await import(new URL('src/v1.4.1/authority-resolver.mjs', ROOT));
const { createFinancialCustomerContext } = await import(new URL('src/v1.4.1/trusted-context.mjs', ROOT));
const { buildStarsInvoicePayload } = await import(new URL('src/v1.3.6/stars-core-foundation.mjs', ROOT));
const { acceptStarsPurchaseTerms, recordStarsSuccessfulPayment, handleStarsPreCheckoutQuery } = await import(new URL('src/v1.3.6/stars-payment-runtime.mjs', ROOT));
const { issuePackageInvoice } = await import(new URL('src/v1.4.4/package-payment-runtime.mjs', ROOT));
const { PACKAGE_CONTRACT_VERSION, PACKAGE_OFFER_VERSION, PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES } = await import(new URL('src/v1.4.4/package-contract.mjs', ROOT));
const { createReferralRewardCandidate } = await import(new URL('src/v1.3.7/referral-reward-candidate-runtime.mjs', ROOT));
const { applyReferralRewardCompensation } = await import(new URL('src/v1.3.7/referral-bonus-access-runtime.mjs', ROOT));
const resolver = createAuthorityResolver();
let sequence = 7440000;
export const nextReferralFixtureUpdate = () => ++sequence;
export const sha = value => createHash('sha256').update(String(value)).digest('hex');
export const sqlStamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
const count = (f, table) => f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

export function installPackageReferralFixtureSchema(f, sql) {
  assert.equal(typeof sql, 'string');
  assert.ok(sql.length > 0, 'the leader must supply the actual package-referral schema SQL');
  f.sqlite.exec(sql);
  f.packageReferralSchemaApplied = true;
}

export function packageReferralFixture(t, { packageReferralSql = null, env = {} } = {}) {
  const f = cabinetSubscriptionFixture(t);
  f.sqlite.function('current_timestamp', { deterministic: false }, () => sqlStamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of [
    '0028-v1.3.7-referral-reward-foundation.sql', '0029-v1.3.7-referral-candidate-cycle-guard.sql',
    '0030-v1.3.7-referral-protection-workflow.sql', '0031-v1.3.7-referral-bonus-access.sql',
    '0032-v1.3.7-referral-ux-admin.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql', '0073-v1.4.4-package-payment-review.sql',
  ]) f.sqlite.exec(fs.readFileSync(new URL('migrations/' + name, ROOT), 'utf8'));
  f.serverEnv = { ...f.serverEnv,
    STARS_PACKAGES_ENABLED: 'true', STARS_PACKAGE_3M_ENABLED: 'true',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '101,900',
    WEBHOOK_SECRET: 'offline-package-referral-webhook-secret',
    REFERRAL_REWARDS_ENABLED: 'true', REFERRAL_REWARD_CANDIDATES_ENABLED: 'true',
    REFERRAL_REWARD_CONFIRMATIONS_ENABLED: 'true', REFERRAL_BONUS_GRANTS_ENABLED: 'true',
    REFERRAL_REWARD_ROLLOUT_MODE: 'public', REFERRAL_REWARD_PROGRAM_STARTED_AT: String(f.now - 86400),
    ...env };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS)) {
    f.sqlite.prepare(`INSERT OR IGNORE INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
      plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds, f.serverEnv.STARS_TERMS_REVISION,
      f.now - 86400, f.now - 86400);
  }
  f.packageReferralSchemaApplied = false;
  if (packageReferralSql !== null) installPackageReferralFixtureSchema(f, packageReferralSql);
  return f;
}

export function seedReferralInvitation(f, { buyer = 900, inviter = 202,
  firstStartedAt = f.now - 7200, boundAt = firstStartedAt + 60 } = {}) {
  assert.ok(firstStartedAt > 0 && boundAt >= firstStartedAt && boundAt <= f.now);
  const prior = f.sqlite.prepare('SELECT inviter_id,inviter_bound_at FROM users WHERE telegram_id=?').get(buyer);
  assert.ok(prior, 'use a real foundation user');
  assert.equal(prior.inviter_id, null, 'never rewrite a previous inviter in a fixture');
  f.sqlite.prepare('UPDATE users SET inviter_id=?,inviter_bound_at=? WHERE telegram_id=? AND inviter_id IS NULL')
    .run(inviter, sqlStamp(boundAt), buyer);
  f.sqlite.prepare(`INSERT INTO bot_start_events(telegram_id,source_code,is_new_user,started_at)
    VALUES(?,'offline_referral_fixture',1,?)`).run(buyer, sqlStamp(firstStartedAt));
  return { buyer, inviter, firstStartedAt, boundAt };
}

// Produces real package evidence using the existing server producers against
// the in-memory binding. The Telegram adapter is a local deterministic stub.
// The current public package admission is owner-only, so this path uses 900.
export async function seedPackageViaProducers(f, { plan = 'professional', packageCode = '3m',
  charge = 'offline-package-referral-charge-' + nextReferralFixtureUpdate() } = {}) {
  const buyer = 900, calls = [], legacyBefore = count(f, 'subscription_access_grants');
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: buyer,
    telegramUpdateId: nextReferralFixtureUpdate(), acceptedAt: f.now - 1 });
  const actor = await resolver.resolveActor(await f.context(buyer, 'access.read_own'));
  const telegramApi = async (_env, method, payload) => {
    calls.push({ method, payload });
    assert.ok(['createInvoiceLink', 'answerPreCheckoutQuery'].includes(method), 'no financial/provider command in fixture');
    return method === 'createInvoiceLink' ? 'https://t.me/$offlineReferralFixture-' + nextReferralFixtureUpdate() : true;
  };
  const issued = await issuePackageInvoice({ actor,
    request: { requestedPlanCode: plan, packageCode }, telegramUpdateId: nextReferralFixtureUpdate(), createdAt: f.now }, { telegramApi });
  const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(issued.orderId);
  async function financial(event) {
    const claim = 'offline-referral-financial-' + event.update_id;
    f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,claim_token,received_at,lease_expires_at)
      VALUES(?, 'message', ?, ?, ?, ?)`).run(event.update_id, buyer, claim, f.now, f.now + 300);
    const request = new Request(f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET }, body: JSON.stringify(event) });
    const context = await createFinancialCustomerContext({ binding: f.binding, env: f.serverEnv,
      webhookRequest: request, receiptClaimToken: claim, nowSeconds: f.now });
    return { packageFinancialContext: context, packageActor: await resolver.resolveActor(context) };
  }
  const checkout = { update_id: nextReferralFixtureUpdate(), pre_checkout_query: { id: 'offline-referral-query-' + nextReferralFixtureUpdate(),
    from: { id: buyer, is_bot: false }, currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload } };
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv, checkout,
    { nowSeconds: f.now, telegramApi, ...await financial(checkout) })).approved, true);
  const update = { update_id: nextReferralFixtureUpdate(), message: { message_id: nextReferralFixtureUpdate(), date: f.now,
    from: { id: buyer, is_bot: false }, chat: { id: buyer, type: 'private' }, successful_payment: {
      currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload,
      telegram_payment_charge_id: charge, provider_payment_charge_id: '' } } };
  const record = await recordStarsSuccessfulPayment(f.serverEnv, update, { receivedAt: f.now, ...await financial(update) });
  assert.equal(record.packagePayment, true);
  assert.ok(['recorded', 'duplicate'].includes(record.status));
  const appliedOrder = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(order.order_id);
  const period = f.sqlite.prepare('SELECT * FROM subscription_package_periods WHERE order_id=?').get(order.order_id);
  const ledger = f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(period.payment_ledger_entry_id);
  assert.equal(appliedOrder.order_state, 'applied');
  assert.equal(count(f, 'subscription_access_grants'), legacyBefore);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_access_grants WHERE order_id=?').get(order.order_id).n, 0);
  return { orderId: order.order_id, periodId: period.period_id, ledgerId: ledger.ledger_entry_id,
    buyer, charge, paidAt: ledger.occurred_at, amountStars: ledger.amount_stars, order: appliedOrder, period, ledger, record, update, calls };
}

// Faster constraint-respecting isolated source for negative/cross-winner tests.
// This deliberately claims SQL fixture facts, not a webhook execution. Existing
// immutable binding/price/overlap triggers remain enabled throughout.
export async function seedPackageRows(f, { buyer = 900, plan = 'professional', packageCode = '3m',
  paidAt = f.now, startsAt = paidAt, charge = 'offline-package-row-charge-' + nextReferralFixtureUpdate() } = {}) {
  const duration = PACKAGE_DURATIONS[packageCode]; assert.ok(duration);
  const price = f.sqlite.prepare('SELECT * FROM price_book WHERE price_id=?').get(`${plan}-${duration.durationDays}d-prepaid-v1`);
  const orderId = randomUUID(), ledgerId = randomUUID(), periodId = randomUUID(), createdAt = paidAt - 10;
  const payload = await buildStarsInvoicePayload({ invoiceSecret: f.serverEnv.STARS_INVOICE_SECRET,
    orderId, telegramId: buyer, priceId: price.price_id });
  f.sqlite.prepare(`INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,
    amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,updated_at)
    VALUES(?,?,?,1,?,'XTR',?,?,'prepaid',?,?,'created',?,?,?)`).run(orderId,buyer,price.price_id,plan,
      price.amount_stars,price.access_seconds,price.terms_revision,payload,createdAt,paidAt+600,createdAt);
  f.sqlite.prepare(`INSERT INTO subscription_package_orders(order_id,telegram_id,contract_version,package_code,duration_days,
    period_seconds,price_id,price_version,plan_code,billing_mode,currency,amount_stars,offer_version,campaign_code,
    quoted_starts_at,quoted_ends_at,source_fingerprint,created_at)
    VALUES(?,?,?,?,?,?,?,1,?,'prepaid','XTR',?,?,NULL,?,?,?,?)`).run(orderId,buyer,PACKAGE_CONTRACT_VERSION,
      packageCode,duration.durationDays,duration.periodSeconds,price.price_id,plan,price.amount_stars,PACKAGE_OFFER_VERSION,
      startsAt,startsAt+duration.periodSeconds,sha('offline-fixture:'+orderId),createdAt);
  f.sqlite.prepare(`UPDATE subscription_orders SET order_state='precheckout_ok',precheckout_approved_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?`)
    .run(paidAt-1,paidAt-1,orderId);
  f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,direction,currency,
    amount_stars,telegram_payment_charge_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,?,'payment','credit','XTR',?,?,'successful_payment',?,?)`).run(ledgerId,'offline-payment:'+ledgerId,
      orderId,buyer,price.amount_stars,charge,paidAt,paidAt);
  f.sqlite.prepare(`UPDATE subscription_orders SET order_state='paid',paid_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?`)
    .run(paidAt,paidAt,orderId);
  f.sqlite.prepare(`INSERT INTO subscription_package_periods(period_id,order_id,payment_ledger_entry_id,telegram_id,plan_code,
    price_id,price_version,billing_mode,starts_at,ends_at,period_seconds,recorded_at)
    VALUES(?,?,?,?,?,?,1,'prepaid',?,?,?,?)`).run(periodId,orderId,ledgerId,buyer,plan,price.price_id,
      startsAt,startsAt+duration.periodSeconds,duration.periodSeconds,paidAt);
  f.sqlite.prepare(`UPDATE subscription_orders SET order_state='applied',applied_at=?,state_revision=state_revision+1,updated_at=? WHERE order_id=?`)
    .run(paidAt,paidAt,orderId);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_access_grants WHERE order_id=?').get(orderId).n, 0);
  return { orderId, ledgerId, periodId, buyer, charge, paidAt, amountStars: price.amount_stars,
    order: f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(orderId),
    period: f.sqlite.prepare('SELECT * FROM subscription_package_periods WHERE period_id=?').get(periodId),
    ledger: f.sqlite.prepare('SELECT * FROM payment_ledger WHERE ledger_entry_id=?').get(ledgerId) };
}

export async function seedMonthlyCandidateViaProducer(f, { inviter = 202 } = {}) {
  seedReferralInvitation(f, { buyer: 101, inviter });
  const paid = await f.paid();
  f.now=Math.max(f.now,f.sqlite.prepare('SELECT applied_at FROM subscription_orders WHERE order_id=?').get(paid.order.order_id).applied_at);
  const candidate = await createReferralRewardCandidate(f.serverEnv, { orderId: paid.order.order_id, selectedAt: f.now });
  assert.ok(['created', 'duplicate'].includes(candidate.status), JSON.stringify(candidate));
  const ledger = f.sqlite.prepare("SELECT * FROM payment_ledger WHERE order_id=? AND entry_type='payment'").get(paid.order.order_id);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM subscription_access_grants WHERE order_id=?').get(paid.order.order_id).n, 1);
  return { ...paid, candidate, orderId: paid.order.order_id, ledgerId: ledger.ledger_entry_id,
    buyer: 101, charge: ledger.telegram_payment_charge_id, paidAt: ledger.occurred_at, amountStars: ledger.amount_stars, ledger };
}

// Synthetic fresh Telegram-side matching proof, not a claim of live API access.
// Use patches to test stale/mismatched run, side, amount, order or charge hash.
export function seedFreshPaymentRecheck(f, source, { checkedAt = source.paidAt + 1814400 + 60,
  run = {}, item = {} } = {}) {
  const runId = randomUUID(), itemId = randomUUID();
  const startedAt = checkedAt - 30, finishedAt = checkedAt - 1;
  const runRow = { run_id: runId, run_source: 'scheduled', status: 'completed', started_at: startedAt,
    finished_at: finishedAt, updated_at: finishedAt, transactions_seen: 1, transactions_matched: 1, ...run };
  const insert = (table, row) => f.sqlite.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  insert('payment_reconciliation_runs', runRow);
  const itemRow = { item_id: itemId, item_key: 'offline-recheck:' + itemId, run_id: runId,
    transaction_id_sha256: sha(source.charge), observation_side: 'telegram', transaction_direction: 'incoming',
    partner_type: 'user', transaction_type: 'invoice_payment', telegram_id: source.buyer, amount_stars: source.amountStars,
    transaction_date: source.paidAt, local_state: 'matched', order_id: source.orderId, ledger_entry_id: source.ledgerId,
    reason_code: 'matched_local_payment', observed_at: finishedAt, ...item };
  insert('payment_reconciliation_items', itemRow);
  return { runId, itemId, checkedAt, run: runRow, item: itemRow };
}

// A genuine matching local compensation row in an isolated DB, never a refund
// API invocation or a manufactured cancellation acknowledgement.
export function seedPackageCompensation(f, source, { type = 'refund', at = source.paidAt + 60 } = {}) {
  assert.ok(['refund','chargeback'].includes(type));
  const ledgerId = randomUUID();
  f.sqlite.prepare(`INSERT INTO payment_ledger(ledger_entry_id,idempotency_key,order_id,telegram_id,entry_type,direction,currency,
    amount_stars,telegram_payment_charge_id,related_ledger_entry_id,reason_code,occurred_at,recorded_at)
    VALUES(?,?,?,?,?,'debit','XTR',?,?,?,'offline_fixture_compensation',?,?)`).run(ledgerId,'offline-compensation:'+ledgerId,
      source.orderId,source.buyer,type,source.amountStars,source.charge,source.ledgerId,at,at);
  return { ledgerId, at, type };
}

const referralSql=fs.readFileSync(new URL('migrations/0074-v1.4.4-package-referral-compatibility.sql',ROOT),'utf8');
function ready(t,options={}) { return packageReferralFixture(t,{packageReferralSql:referralSql,...options}); }
async function packageCandidate(t,{fixtureOptions={},invitation={},sourceOptions={},producer=false}={}) {
  const f=ready(t,fixtureOptions);
  seedReferralInvitation(f,invitation);
  const source=producer?await seedPackageViaProducers(f,sourceOptions):await seedPackageRows(f,sourceOptions);
  const candidate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:source.orderId,selectedAt:f.now});
  return {f,source,candidate};
}
const reward=(f,id)=>f.sqlite.prepare('SELECT * FROM package_referral_rewards WHERE reward_id=?').get(id);
const checks=(f,id)=>f.sqlite.prepare('SELECT * FROM package_referral_protection_checks WHERE reward_id=? ORDER BY reward_revision').all(id);
const slots=f=>f.sqlite.prepare('SELECT * FROM referral_reward_lifetime_slots ORDER BY source_order_id').all();
const successfulWorkflow=()=>({calls:[],async get(){throw new Error('isolated missing instance');},async create(value){this.calls.push(value);return {id:value.id};}});

test('actual isolated package payment creates an idempotent candidate, shared lifetime claim and durable21-day job without legacy access',async t=>{
  const {f,source,candidate}=await packageCandidate(t,{producer:true});
  assert.equal(candidate.status,'created'); assert.equal(candidate.accessApplied,false);
  assert.equal(source.record.accessApplied,false);
  assert.equal(count(f,'subscription_access_grants'),0); assert.equal(count(f,'referral_reward_candidates'),0);
  assert.equal(candidate.confirmAfter,source.paidAt+1814400); assert.equal(slots(f).length,1);
  assert.equal(slots(f)[0].source_kind,'package');
  const duplicate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:source.orderId,selectedAt:f.now});
  assert.equal(duplicate.status,'duplicate'); assert.equal(duplicate.rewardId,candidate.rewardId);
  assert.equal(count(f,'package_referral_candidates'),1); assert.equal(count(f,'package_referral_rewards'),1);
  const schedule=await getPackageReferralProtectionSchedule(f.serverEnv,{rewardId:candidate.rewardId});
  assert.equal(schedule.status,'scheduled'); assert.equal(schedule.confirmAfter,candidate.confirmAfter);
});

test('future paid package qualifies at the genuine payment time and keeps its immutable future period',async t=>{
  const {f,source,candidate}=await packageCandidate(t,{sourceOptions:{startsAt:Math.floor(Date.now()/1000)+7776000}});
  assert.equal(candidate.status,'created'); assert.equal(candidate.confirmAfter,source.paidAt+1814400);
  assert.ok(source.period.starts_at>candidate.confirmAfter); assert.equal(candidate.accessApplied,false);
  assert.equal(f.sqlite.prepare('SELECT starts_at FROM subscription_package_periods WHERE period_id=?').get(source.periodId).starts_at,source.period.starts_at);
});

test('eligibility includes the30-day boundary and rejects the next second',async t=>{
  for (const outside of [false,true]) {
    const f=ready(t); seedReferralInvitation(f,{firstStartedAt:f.now-2592000-(outside?1:0),boundAt:f.now-2592000});
    const source=await seedPackageRows(f);
    const candidate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:source.orderId,selectedAt:f.now});
    assert.equal(candidate.status,outside?'ineligible':'created');
    if (outside) assert.equal(candidate.reason,'payment_after_eligibility_window');
  }
});

test('beneficiary rollout gates the inviter independently of the buyer',async t=>{
  const blocked=await packageCandidate(t,{fixtureOptions:{env:{REFERRAL_REWARD_ROLLOUT_MODE:'admin',ADMIN_ID:'900'}}});
  assert.equal(blocked.candidate.status,'ineligible'); assert.equal(blocked.candidate.reason,'admin_canary_only');
  const allowed=await packageCandidate(t,{fixtureOptions:{env:{REFERRAL_REWARD_ROLLOUT_MODE:'admin',ADMIN_ID:'900'}},
    invitation:{buyer:101,inviter:900},sourceOptions:{buyer:101}});
  assert.equal(allowed.candidate.status,'created');
});

test('a compensated earlier first payment does not restore first-paid eligibility for another package',async t=>{
  const f=ready(t); seedReferralInvitation(f,{firstStartedAt:f.now-3000,boundAt:f.now-2990});
  const earlier=await seedPackageRows(f,{paidAt:f.now-1000}); seedPackageCompensation(f,earlier,{at:f.now-900});
  const later=await seedPackageRows(f);
  const candidate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:later.orderId,selectedAt:f.now});
  assert.equal(candidate.status,'ineligible'); assert.equal(candidate.reason,'not_first_paid_purchase'); assert.equal(slots(f).length,0);
});

test('legacy monthly claims are backfilled without changing any legacy row and block package reuse',async t=>{
  const f=packageReferralFixture(t),monthly=await seedMonthlyCandidateViaProducer(f);
  const oldRefund=seedPackageCompensation(f,monthly,{at:f.now+60});
  await applyReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:oldRefund.ledgerId,recordedAt:oldRefund.at});
  assert.equal(f.sqlite.prepare('SELECT reward_status FROM referral_rewards WHERE reward_id=?').get(monthly.candidate.rewardId).reward_status,'cancelled');
  const oldCandidates=f.sqlite.prepare('SELECT * FROM referral_reward_candidates').all();
  const oldRewards=f.sqlite.prepare('SELECT * FROM referral_rewards').all();
  installPackageReferralFixtureSchema(f,referralSql);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM referral_reward_candidates').all(),oldCandidates);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM referral_rewards').all(),oldRewards);
  assert.equal(slots(f)[0].source_kind,'legacy'); assert.equal(slots(f)[0].source_order_id,monthly.orderId);
  seedReferralInvitation(f); const source=await seedPackageRows(f);
  const candidate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:source.orderId,selectedAt:f.now});
  assert.equal(candidate.status,'ineligible'); assert.equal(candidate.reason,'inviter_reward_already_used');
});

test('package lifetime claim blocks a subsequent genuine monthly candidate for the same inviter',async t=>{
  const {f,candidate}=await packageCandidate(t); assert.equal(candidate.status,'created');
  seedReferralInvitation(f,{buyer:101}); const paid=await f.paid();
  const selectedAt=Math.max(f.now,f.sqlite.prepare('SELECT applied_at FROM subscription_orders WHERE order_id=?').get(paid.order.order_id).applied_at);
  const monthly=await createReferralRewardCandidate(f.serverEnv,{orderId:paid.order.order_id,selectedAt});
  assert.equal(monthly.status,'ineligible'); assert.equal(monthly.reason,'inviter_reward_already_used');
  assert.equal(count(f,'referral_reward_candidates'),0); assert.equal(slots(f).length,1);
});

test('cross-buyer claim race rolls back every losing candidate/reward/job atomically',async t=>{
  const f=ready(t); seedReferralInvitation(f); seedReferralInvitation(f,{buyer:101});
  const first=await seedPackageRows(f),winner=await seedPackageRows(f,{buyer:101});
  let winning;
  f.binding.beforeBatch=async()=>{winning=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:winner.orderId,selectedAt:f.now});};
  const losing=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:first.orderId,selectedAt:f.now});
  assert.equal(winning.status,'created'); assert.equal(losing.status,'ineligible'); assert.equal(losing.reason,'inviter_reward_already_used');
  for (const table of ['package_referral_candidates','package_referral_rewards','package_referral_protection_jobs']) assert.equal(count(f,table),1);
  assert.equal(slots(f).length,1); assert.equal(slots(f)[0].source_order_id,winner.orderId); assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('a candidate response lost after COMMIT is verified as duplicate without claiming another slot',async t=>{
  const f=ready(t); seedReferralInvitation(f); const source=await seedPackageRows(f),batch=f.binding.batch.bind(f.binding); let lose=true;
  f.binding.batch=async statements=>{const value=await batch(statements);if(lose){lose=false;throw new Error('isolated lost commit response');}return value;};
  const candidate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:source.orderId,selectedAt:f.now});
  assert.equal(candidate.status,'duplicate'); assert.equal(slots(f).length,1); assert.equal(count(f,'package_referral_rewards'),1);
});

test('confirmation waits21days and refuses missing or pre-hold Telegram proof',async t=>{
  const {f,source,candidate}=await packageCandidate(t);
  const early=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,checkedAt:candidate.confirmAfter-1});
  assert.equal(early.status,'waiting'); assert.equal(checks(f,candidate.rewardId).length,0);
  const missing=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,checkedAt:candidate.confirmAfter+60});
  assert.equal(missing.status,'manual_review'); assert.equal(missing.reason,'package_referral_payment_recheck_missing');
  const stale=seedFreshPaymentRecheck(f,source,{run:{started_at:candidate.confirmAfter-1}});
  const rejected=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:stale.runId,checkedAt:stale.checkedAt});
  assert.equal(rejected.status,'manual_review'); assert.equal(reward(f,candidate.rewardId).reward_status,'pending');
});

test('mismatched side, direction, amount, order, charge and future observation cannot confirm',async t=>{
  for (const patch of [{observation_side:'local'},{transaction_direction:'outgoing'},{amount_stars:1},{order_id:null},
    {transaction_id_sha256:'0'.repeat(64)},{observed_at:Math.floor(Date.now()/1000)+1814400+999}]) {
    const {f,source,candidate}=await packageCandidate(t),proof=seedFreshPaymentRecheck(f,source,{item:patch});
    const rejected=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:proof.checkedAt});
    assert.equal(rejected.status,'manual_review',JSON.stringify(patch)); assert.equal(reward(f,candidate.rewardId).reward_status,'pending');
    assert.equal(checks(f,candidate.rewardId).length,0); assert.equal(count(f,'bonus_access_grants'),0);
  }
});

test('fresh exact Telegram proof confirms once and exposes atomic genuine package proof for bonus delivery',async t=>{
  const {f,source,candidate}=await packageCandidate(t),proof=seedFreshPaymentRecheck(f,source);
  const verified=await reconcilePackageReferralRewardSourcePayment(f.serverEnv,{rewardId:candidate.rewardId,checkedAt:proof.checkedAt});
  assert.equal(verified.status,'verified'); assert.equal(verified.reused,true);
  const settled=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:proof.checkedAt});
  assert.equal(settled.outcome,'confirmed'); assert.equal(settled.accessApplied,false);
  const repeated=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:proof.checkedAt+1});
  assert.equal(repeated.status,'already_settled'); assert.equal(checks(f,candidate.rewardId).length,1);
  const read=await readPackageReferralRewardForBonus(f.serverEnv,{rewardId:candidate.rewardId,checkedAt:proof.checkedAt});
  assert.equal(read.status,'confirmed'); assert.equal(read.sourcePackagePeriodId,source.periodId); assert.equal(read.sourcePaymentLedgerEntryId,source.ledgerId);
  assert.equal(read.confirmedAt,proof.checkedAt); assert.equal(read.reconciliationRunId,proof.runId); assert.ok(read.assertions.length>=4);
  assert.equal(count(f,'bonus_access_grants'),0); assert.equal(count(f,'subscription_access_grants'),0);
});

test('a matching refund cancels beforehold even when features are disabled and never releases lifetime slots',async t=>{
  const {f,source,candidate}=await packageCandidate(t),compensation=seedPackageCompensation(f,source);
  const disabled={...f.serverEnv,REFERRAL_REWARDS_ENABLED:'false',REFERRAL_REWARD_CONFIRMATIONS_ENABLED:'false'};
  const cancelled=await applyPackageReferralRewardCompensation(disabled,{compensationLedgerEntryId:compensation.ledgerId,recordedAt:compensation.at});
  assert.equal(cancelled.outcome,'cancelled'); assert.equal(checks(f,candidate.rewardId)[0].decision,'cancel'); assert.equal(slots(f).length,1);
  assert.equal(count(f,'bonus_access_grants'),0);
  const duplicate=await applyPackageReferralRewardCompensation(disabled,{compensationLedgerEntryId:compensation.ledgerId,recordedAt:compensation.at+1});
  assert.equal(duplicate.status,'already_settled'); assert.equal(checks(f,candidate.rewardId).length,1);
});

test('a late matching chargeback cancels a confirmed reward and retains both confirmation and reversal evidence',async t=>{
  const {f,source,candidate}=await packageCandidate(t),proof=seedFreshPaymentRecheck(f,source);
  await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:proof.checkedAt});
  const periodBefore=f.sqlite.prepare('SELECT * FROM subscription_package_periods WHERE period_id=?').get(source.periodId);
  const compensation=seedPackageCompensation(f,source,{type:'chargeback',at:proof.checkedAt+60});
  const cancelled=await applyPackageReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:compensation.ledgerId,recordedAt:compensation.at});
  assert.equal(cancelled.outcome,'cancelled'); assert.equal(reward(f,candidate.rewardId).revision,3);
  assert.deepEqual(checks(f,candidate.rewardId).map(row=>row.decision),['confirm','cancel']);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_periods WHERE period_id=?').get(source.periodId),periodBefore);
  const read=await readPackageReferralRewardForBonus(f.serverEnv,{rewardId:candidate.rewardId,checkedAt:compensation.at});
  assert.equal(read.status,'cancelled'); assert.equal(read.confirmedAt,proof.checkedAt); assert.equal(read.compensationLedgerEntryId,compensation.ledgerId);
  assert.equal(slots(f).length,1);
});

test('compensation racing confirmation wins atomically and never creates a confirmed reward',async t=>{
  const {f,source,candidate}=await packageCandidate(t),proof=seedFreshPaymentRecheck(f,source);
  f.binding.beforeBatch=()=>seedPackageCompensation(f,source,{at:proof.checkedAt});
  const settled=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:proof.checkedAt});
  assert.equal(settled.outcome,'cancelled'); assert.equal(reward(f,candidate.rewardId).confirmed_at,null);
  assert.deepEqual(checks(f,candidate.rewardId).map(row=>row.decision),['cancel']); assert.equal(count(f,'mini_app_atomic_guards'),0);
});

test('workflow creation, repair, persisted identity and terminal completion use the existing binding and actual package job',async t=>{
  const {f,source,candidate}=await packageCandidate(t),binding=successfulWorkflow(); f.serverEnv.REFERRAL_REWARD_PROTECTION_WORKFLOW=binding;
  const identity=await resolvePackageReferralProtectionIdentity(f.serverEnv,{rewardId:candidate.rewardId}); assert.equal(identity.rewardKind,'package');
  const repaired=await repairPackageReferralRewardProtection(f.serverEnv,{requestedAt:f.now}); assert.equal(repaired.results[0].status,'started');
  assert.equal(binding.calls.length,1); assert.equal(binding.calls[0].params.rewardId,candidate.rewardId);
  const repeated=await ensurePackageReferralProtectionWorkflow(f.serverEnv,{rewardId:candidate.rewardId,requestedAt:f.now+1});
  assert.equal(repeated.reason,'workflow_already_started'); assert.equal(binding.calls.length,1);
  const proof=seedFreshPaymentRecheck(f,source),settled=await settlePackageReferralRewardProtection(f.serverEnv,
    {rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:proof.checkedAt});
  const completed=await completePackageReferralProtectionJob(f.serverEnv,{rewardId:candidate.rewardId,transitionId:settled.transitionId,
    outcome:settled.outcome,reconciliationRunId:proof.runId,completedAt:proof.checkedAt}); assert.equal(completed.status,'completed');
  assert.equal((await getPackageReferralProtectionSchedule(f.serverEnv,{rewardId:candidate.rewardId})).outcome,'confirmed');
});

test('unknown workflow acknowledgement stays start_failed; observed active instance permits safe recovery',async t=>{
  const {f,candidate}=await packageCandidate(t); let active=false,creates=0;
  f.serverEnv.REFERRAL_REWARD_PROTECTION_WORKFLOW={async get(){if(!active)throw new Error('missing');return {async status(){return {status:'running'};}};},
    async create(){creates++;throw new Error('lost create acknowledgement');}};
  const unknown=await ensurePackageReferralProtectionWorkflow(f.serverEnv,{rewardId:candidate.rewardId,requestedAt:f.now});
  assert.equal(unknown.status,'start_failed'); active=true;
  const recovered=await ensurePackageReferralProtectionWorkflow(f.serverEnv,{rewardId:candidate.rewardId,requestedAt:f.now+1});
  assert.equal(recovered.status,'started'); assert.equal(recovered.reason,'workflow_instance_recovered'); assert.equal(creates,1);
  const manual=await markPackageReferralProtectionJobManualReview(f.serverEnv,{rewardId:candidate.rewardId,reason:'payment_recheck_missing',recordedAt:f.now+2});
  assert.equal(manual.status,'manual_review');
});

test('a reward UUID collision across genuine legacy/package stores fails closed instead of trusting event kind',async t=>{
  const {f,candidate}=await packageCandidate(t);
  seedReferralInvitation(f,{buyer:101,inviter:303}); const paid=await f.paid();
  const at=Math.max(f.now,f.sqlite.prepare('SELECT applied_at FROM subscription_orders WHERE order_id=?').get(paid.order.order_id).applied_at);
  const original=crypto.randomUUID; let sequence=0;
  crypto.randomUUID=()=>++sequence===2?candidate.rewardId:randomUUID();
  try { assert.equal((await createReferralRewardCandidate(f.serverEnv,{orderId:paid.order.order_id,selectedAt:at})).status,'created'); }
  finally { crypto.randomUUID=original; }
  await assert.rejects(()=>resolvePackageReferralProtectionIdentity(f.serverEnv,{rewardId:candidate.rewardId}),
    {code:'package_referral_reward_identity_collision'});
});

test('a second genuine compensation type verifies its own identity and preserves the original cancelled decision',async t=>{
  const {f,source,candidate}=await packageCandidate(t),refund=seedPackageCompensation(f,source);
  await applyPackageReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:refund.ledgerId,recordedAt:refund.at});
  const chargeback=seedPackageCompensation(f,source,{type:'chargeback',at:refund.at+1});
  const repeated=await applyPackageReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:chargeback.ledgerId,recordedAt:chargeback.at});
  assert.equal(repeated.status,'already_settled'); assert.equal(repeated.outcome,'cancelled');
  assert.equal(checks(f,candidate.rewardId).length,1); assert.equal(slots(f).length,1);
});

test('production payment attach connects genuine package payment with accessAppliedfalse to candidate and same-binding Workflow',async t=>{
  const f=ready(t); seedReferralInvitation(f); const source=await seedPackageViaProducers(f),binding=successfulWorkflow();
  f.serverEnv.REFERRAL_REWARD_PROTECTION_WORKFLOW=binding;
  assert.equal(source.record.packagePayment,true); assert.equal(source.record.accessApplied,false);
  const attached=await attachReferralCandidateAfterAppliedAccess(f.serverEnv,source.update,source.record,{selectedAt:f.now});
  assert.equal(attached.accessApplied,false); assert.equal(attached.orderId,source.orderId); assert.equal(attached.ledgerEntryId,source.ledgerId);
  assert.equal(attached.referralReward.status,'created'); assert.equal(attached.referralReward.protection.status,'started');
  const stored=f.sqlite.prepare('SELECT * FROM package_referral_protection_jobs WHERE reward_id=?').get(attached.referralReward.rewardId);
  assert.equal(stored.workflow_state,'started'); assert.equal(binding.calls.length,1);
  assert.equal(binding.calls[0].id,stored.workflow_instance_id); assert.equal(binding.calls[0].params.rewardId,attached.referralReward.rewardId);
  const replay=await attachReferralCandidateAfterAppliedAccess(f.serverEnv,source.update,source.record,{selectedAt:f.now});
  assert.equal(replay.referralReward.status,'duplicate'); assert.equal(binding.calls.length,1);
  assert.equal(count(f,'subscription_access_grants'),0); assert.equal(count(f,'referral_reward_candidates'),0);
});

test('actual legacy Workflow dispatches package by stored identity, waits21days, reconciles exact local Telegram response, delivers bonus and completes job',async t=>{
  register(new URL('./cloudflare-workers-loader.mjs',import.meta.url));
  const {ReferralRewardProtectionWorkflow}=await import('../src/v1.3.7/referral-reward-protection-workflow.mjs');
  const f=ready(t); seedReferralInvitation(f); const source=await seedPackageViaProducers(f),binding=successfulWorkflow();
  f.serverEnv.REFERRAL_REWARD_PROTECTION_WORKFLOW=binding; f.serverEnv.STARS_RECONCILIATION_ENABLED='true';
  const attached=await attachReferralCandidateAfterAppliedAccess(f.serverEnv,source.update,source.record,{selectedAt:f.now});
  const candidate=attached.referralReward; assert.equal(candidate.protection.status,'started');
  const originalNow=Date.now,originalFetch=globalThis.fetch;let simulatedNow=f.now;const steps=[],calls=[];
  Date.now=()=>simulatedNow*1000;
  globalThis.fetch=async(url,options)=>{
    const target=new URL(url); assert.equal(target.hostname,'api.telegram.org');
    assert.equal(target.pathname,'/bot'+f.serverEnv.BOT_TOKEN+'/getStarTransactions');
    const payload=JSON.parse(options.body); assert.deepEqual(payload,{offset:0,limit:100}); calls.push({method:'getStarTransactions',payload});
    return Response.json({ok:true,result:{transactions:[{id:source.charge,amount:source.amountStars,date:source.paidAt,
      source:{type:'user',transaction_type:'invoice_payment',user:{id:source.buyer,is_bot:false},invoice_payload:source.order.invoice_payload}}]}});
  };
  t.after(()=>{Date.now=originalNow;globalThis.fetch=originalFetch;});
  const beforeLedger=f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all();
  const beforePeriod=f.sqlite.prepare('SELECT * FROM subscription_package_periods ORDER BY period_id').all();
  const step={async do(name,policy,operation){steps.push(name);assert.ok(policy.retries);return operation();},
    async sleepUntil(name,deadline){steps.push(name);assert.equal(deadline,candidate.confirmAfter*1000);
      assert.equal(reward(f,candidate.rewardId).reward_status,'pending'); assert.equal(count(f,'package_referral_protection_checks'),0);
      simulatedNow=Math.floor(deadline/1000);f.now=simulatedNow;}};
  const workflow=new ReferralRewardProtectionWorkflow({},f.serverEnv);
  // This intentionally misleading field must have no dispatch authority.
  const outcome=await workflow.run({payload:{rewardId:candidate.rewardId,rewardKind:'legacy'}},step);
  assert.equal(outcome.outcome,'confirmed'); assert.equal(outcome.accessApplied,false);
  assert.equal(calls.length,1); assert.equal(outcome.bonusAccess.status,'claimable');
  assert.equal(outcome.bonusAccess.deliveryMode,'manual_claim'); assert.equal(outcome.bonusAccess.planCode,'professional');
  const grant=f.sqlite.prepare('SELECT * FROM package_referral_bonus_grants WHERE package_reward_id=?').get(candidate.rewardId);
  assert.ok(grant); assert.equal(grant.bonus_seconds,259200); assert.equal(grant.available_at,candidate.confirmAfter);
  assert.equal(grant.claim_expires_at,candidate.confirmAfter+2592000); assert.equal(grant.beneficiary_telegram_id,202);
  const stored=f.sqlite.prepare('SELECT * FROM package_referral_protection_jobs WHERE reward_id=?').get(candidate.rewardId);
  assert.equal(stored.workflow_state,'completed'); assert.equal(stored.settlement_outcome,'confirmed'); assert.equal(stored.settled_transition_id,outcome.transitionId);
  const check=checks(f,candidate.rewardId)[0],recheck=f.sqlite.prepare('SELECT * FROM payment_reconciliation_items WHERE item_id=?').get(check.reconciliation_item_id);
  assert.equal(recheck.observation_side,'telegram'); assert.equal(recheck.transaction_id_sha256,sha(source.charge));
  assert.equal(recheck.ledger_entry_id,source.ledgerId); assert.equal(recheck.order_id,source.orderId);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),beforeLedger);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM subscription_package_periods ORDER BY period_id').all(),beforePeriod);
  assert.equal(count(f,'subscription_access_grants'),0); assert.equal(count(f,'referral_rewards'),0); assert.equal(count(f,'bonus_access_grants'),0);
  assert.ok(steps.includes('wait until referral protection hold ends')); assert.ok(steps.includes('prepare referral bonus access idempotently'));
});

for (const scenario of ['found','missing','refunded','mismatched','retry']) test('referral Workflow continues past 2000 provider transactions: '+scenario,async t=>{
  register(new URL('./cloudflare-workers-loader.mjs',import.meta.url));
  const {ReferralRewardProtectionWorkflow}=await import('../src/v1.3.7/referral-reward-protection-workflow.mjs');
  const f=ready(t); seedReferralInvitation(f); const source=await seedPackageViaProducers(f);
  f.serverEnv.REFERRAL_REWARD_PROTECTION_WORKFLOW=successfulWorkflow();
  f.serverEnv.STARS_RECONCILIATION_ENABLED='true';
  const {referralReward:candidate}=await attachReferralCandidateAfterAppliedAccess(f.serverEnv,source.update,source.record,{selectedAt:f.now});
  const originalNow=Date.now,originalFetch=globalThis.fetch;let simulatedNow=f.now;
  const steps=[],offsets=[],cachedSteps=new Map(),stepCosts=[],queryStart=f.binding.audit.length,
    beforeLedger=f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all();
  let retried=false,refunded=false;
  Date.now=()=>simulatedNow*1000;
  t.after(()=>{Date.now=originalNow;globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url,options)=>{
    const target=new URL(url);assert.equal(target.hostname,'api.telegram.org');
    assert.equal(target.pathname,'/bot'+f.serverEnv.BOT_TOKEN+'/getStarTransactions');
    const {offset,limit}=JSON.parse(options.body);assert.equal(limit,100);offsets.push(offset);
    if(offset===2000&&scenario==='retry'&&!retried){retried=true;throw new Error('isolated provider interruption');}
    if(offset===2000&&scenario==='refunded'&&!refunded){refunded=true;seedPackageCompensation(f,source,{at:f.now});}
    const transactions=offset<2000?Array.from({length:100},(_,i)=>({id:'unrelated-'+(offset+i),amount:1,
      date:source.paidAt+1,source:{type:'other'}})):scenario==='missing'?[]:[{id:source.charge,
      amount:source.amountStars+(scenario==='mismatched'?1:0),date:source.paidAt,
      source:{type:'user',transaction_type:'invoice_payment',user:{id:source.buyer,is_bot:false},invoice_payload:source.order.invoice_payload}}];
    return Response.json({ok:true,result:{transactions}});
  };
  const step={async do(name,policy,operation){
      steps.push(name);assert.ok(policy.retries);
      if(cachedSteps.has(name))return cachedSteps.get(name);
      const beforeQueries=f.binding.audit.length,beforeRequests=offsets.length;
      let value;
      try{value=await operation();}catch(error){
        assert.equal(scenario,'retry');assert.match(name,/from offset 2000$/);
        assert.equal(count(f,'package_referral_protection_checks'),0);
        value=await operation();
      }
      stepCosts.push({name,d1Statements:f.binding.audit.length-beforeQueries,providerCalls:offsets.length-beforeRequests});
      cachedSteps.set(name,value);return value;
    },
    async sleepUntil(_name,deadline){simulatedNow=Math.floor(deadline/1000);f.now=simulatedNow;}};
  const outcome=await new ReferralRewardProtectionWorkflow({},f.serverEnv).run({payload:{rewardId:candidate.rewardId}},step);
  const expectedOffsets=Array.from({length:21},(_,i)=>i*100);if(scenario==='retry')expectedOffsets.push(2000);
  assert.deepEqual(offsets,expectedOffsets);
  assert.ok(steps.includes('reconcile exact referral source payment from offset 2000'));
  const runs=f.sqlite.prepare('SELECT offset_start,offset_end,status FROM payment_reconciliation_runs ORDER BY offset_start,offset_end').all();
  assert.deepEqual(runs.filter(r=>r.status!=='failed').map(r=>[r.offset_start,r.offset_end,r.status]),
    [[0,2000,'manual_review'],[2000,scenario==='missing'?2000:2001,'manual_review']]);
  assert.equal(runs.filter(r=>r.status==='failed').length,scenario==='retry'?1:0);
  if(['found','retry'].includes(scenario)){
    assert.equal(outcome.outcome,'confirmed',JSON.stringify(outcome));
    const check=checks(f,candidate.rewardId)[0];
    assert.equal(f.sqlite.prepare('SELECT offset_start FROM payment_reconciliation_runs WHERE run_id=?').get(check.reconciliation_run_id).offset_start,2000);
    assert.equal(checks(f,candidate.rewardId).length,1);assert.equal(count(f,'package_referral_bonus_grants'),1);
    // Replay successful durable steps without re-reading earlier provider pages
    // or issuing a second reward/bonus.
    await new ReferralRewardProtectionWorkflow({},f.serverEnv).run({payload:{rewardId:candidate.rewardId}},step);
    assert.deepEqual(offsets,expectedOffsets);assert.equal(checks(f,candidate.rewardId).length,1);
    assert.equal(count(f,'package_referral_bonus_grants'),1);
  }else{
    assert.equal(count(f,'package_referral_bonus_grants'),0);
    if(scenario==='refunded')assert.equal(outcome.outcome,'cancelled');
    else{
      assert.equal(outcome.status,'manual_review');assert.equal(checks(f,candidate.rewardId).length,0);
      assert.equal(reward(f,candidate.rewardId).reward_status,'pending');
    }
  }
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM payment_ledger WHERE entry_type='payment' ORDER BY ledger_entry_id").all(),beforeLedger);
  assert.equal(count(f,'payment_ledger'),beforeLedger.length+(scenario==='refunded'?1:0));
  assert.equal(count(f,'payment_reconciliation_items'),scenario==='missing'?0:1,'unrelated transactions are not journaled as target proof');
  const subrequests=f.binding.audit.length-queryStart+offsets.length;
  assert.ok(subrequests<1000,'targeted exact-source recheck must fit the default Workflow subrequest budget');
  t.diagnostic(JSON.stringify({scenario,subrequests,stepCosts}));
});

test('targeted referral scan stops within the default Workflow budget even when every window exhausts five retries',async t=>{
  register(new URL('./cloudflare-workers-loader.mjs',import.meta.url));
  const {ReferralRewardProtectionWorkflow}=await import('../src/v1.3.7/referral-reward-protection-workflow.mjs');
  const {MAX_REFERRAL_RECONCILIATION_WINDOWS}=await import('../src/v1.3.7/referral-reconciliation-pagination.mjs');
  const f=ready(t);seedReferralInvitation(f);const source=await seedPackageViaProducers(f);
  f.serverEnv.REFERRAL_REWARD_PROTECTION_WORKFLOW=successfulWorkflow();f.serverEnv.STARS_RECONCILIATION_ENABLED='true';
  const {referralReward:candidate}=await attachReferralCandidateAfterAppliedAccess(f.serverEnv,source.update,source.record,{selectedAt:f.now});
  const originalNow=Date.now,originalFetch=globalThis.fetch,failures=new Map(),costs=[];
  let simulatedNow=f.now,providerCalls=0;
  Date.now=()=>simulatedNow*1000;t.after(()=>{Date.now=originalNow;globalThis.fetch=originalFetch;});
  globalThis.fetch=async(url,options)=>{
    const target=new URL(url);assert.equal(target.hostname,'api.telegram.org');
    assert.equal(target.pathname,'/bot'+f.serverEnv.BOT_TOKEN+'/getStarTransactions');
    const {offset,limit}=JSON.parse(options.body);assert.equal(limit,100);providerCalls++;
    const window=Math.floor(offset/2000);
    if(offset%2000===1900&&(failures.get(window)||0)<5){failures.set(window,(failures.get(window)||0)+1);throw new Error('isolated last-page interruption');}
    return Response.json({ok:true,result:{transactions:Array.from({length:100},(_,i)=>({
      id:'unrelated-growing-feed-'+(offset+i),amount:1,date:source.paidAt+1,source:{type:'other'}}))}});
  };
  const before=f.binding.audit.length;
  const step={async do(name,policy,operation){
      for(let attempt=0;attempt<=policy.retries.limit;attempt++){
        const reads=f.binding.audit.length,calls=providerCalls;
        try{return await operation();}catch(error){
          assert.match(name,/^reconcile exact referral source payment/);if(attempt===policy.retries.limit)throw error;
        }finally{costs.push(f.binding.audit.length-reads+providerCalls-calls);}
      }
    },async sleepUntil(_name,deadline){simulatedNow=Math.floor(deadline/1000);f.now=simulatedNow;}};
  const outcome=await new ReferralRewardProtectionWorkflow({},f.serverEnv).run({payload:{rewardId:candidate.rewardId}},step);
  assert.equal(outcome.status,'manual_review');assert.equal(outcome.reason,'referral_reconciliation_scan_budget_exhausted');
  assert.equal(outcome.nextOffset,2000*MAX_REFERRAL_RECONCILIATION_WINDOWS);
  assert.equal(failures.size,MAX_REFERRAL_RECONCILIATION_WINDOWS);
  assert.ok([...failures.values()].every(value=>value===5));
  assert.equal(count(f,'package_referral_protection_checks'),0);assert.equal(count(f,'package_referral_bonus_grants'),0);
  assert.equal(count(f,'payment_reconciliation_items'),0);assert.equal(reward(f,candidate.rewardId).reward_status,'pending');
  const subrequests=f.binding.audit.length-before+providerCalls;
  assert.ok(subrequests<5000,'retain more than half of the default 10000 subrequest budget');
  assert.ok(Math.max(...costs)<100,'each targeted empty-history attempt stays bounded');
  assert.equal(f.sqlite.prepare('SELECT workflow_state FROM package_referral_protection_jobs WHERE reward_id=?').get(candidate.rewardId).workflow_state,'manual_review');
  t.diagnostic(JSON.stringify({subrequests,providerCalls,maxAttemptSubrequests:Math.max(...costs),completedWindows:failures.size}));
});

for(const kind of ['malformed','conflicting','unverified-reversal','unrecognized']) test('targeted referral evidence fails closed for '+kind,async t=>{
  const {reconcileStarsTransactions}=await import('../src/v1.3.6/stars-access-runtime.mjs');
  const {f,source,candidate}=await packageCandidate(t,{producer:true});
  f.serverEnv.STARS_RECONCILIATION_ENABLED='true';f.now=candidate.confirmAfter;
  const originalNow=Date.now;Date.now=()=>f.now*1000;t.after(()=>{Date.now=originalNow;});
  const incoming={id:source.charge,amount:source.amountStars,date:source.paidAt,
    source:{type:'user',transaction_type:'invoice_payment',user:{id:source.buyer,is_bot:false},invoice_payload:source.order.invoice_payload}};
  const bad=kind==='malformed'?{...incoming,date:0}:kind==='conflicting'?{...incoming,amount:source.amountStars+1}:kind==='unrecognized'?
    {id:source.charge,amount:source.amountStars,date:f.now,receiver:{type:'other'}}:
    {id:source.charge,amount:source.amountStars,date:f.now,receiver:{type:'user',transaction_type:'invoice_payment',user:{id:source.buyer,is_bot:false}}};
  const transactions=kind==='malformed'?[bad,incoming]:[incoming,bad];
  const reason=kind==='malformed'?'reconciliation_target_malformed_evidence':kind==='conflicting'?
    'reconciliation_target_conflicting_evidence':kind==='unrecognized'?
    'reconciliation_target_unrecognized_evidence':'reconciliation_target_reversal_unverified';
  await assert.rejects(reconcilePackageReferralRewardSourcePayment(f.serverEnv,{rewardId:candidate.rewardId,checkedAt:f.now},
    {reconcileTransactions:(env,args)=>reconcileStarsTransactions(env,args,{telegramApi:async(_env,method)=>{
      assert.equal(method,'getStarTransactions');return {transactions};}})}),error=>error.code===reason);
  assert.equal(f.sqlite.prepare('SELECT status FROM payment_reconciliation_runs').get().status,'failed');
  assert.equal(count(f,'package_referral_protection_checks'),0);assert.equal(count(f,'package_referral_bonus_grants'),0);
  assert.equal(reward(f,candidate.rewardId).reward_status,'pending');assert.equal(count(f,'payment_ledger'),1);
});
