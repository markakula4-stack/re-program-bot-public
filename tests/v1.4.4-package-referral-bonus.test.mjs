import test from 'node:test';
// Scratch-only isolated SQLite/D1 fixture. It never connects to a live provider.
// Import this module from scratch, or adapt ROOT when moving it into a test helper.
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
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '101,202,900',
    WEBHOOK_SECRET: 'offline-package-referral-webhook-secret',
    REFERRAL_REWARDS_ENABLED: 'true', REFERRAL_REWARD_CANDIDATES_ENABLED: 'true',
    REFERRAL_REWARD_CONFIRMATIONS_ENABLED: 'true', REFERRAL_BONUS_GRANTS_ENABLED: 'true',
    REFERRAL_REWARD_ROLLOUT_MODE: 'public', REFERRAL_REWARD_PROGRAM_STARTED_AT: String(f.now - 60*86400),
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
    buyer, charge, paidAt: ledger.occurred_at, amountStars: ledger.amount_stars, order: appliedOrder, period, ledger, record, calls };
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
  const recorded=f.sqlite.prepare("SELECT recorded_at FROM payment_ledger WHERE order_id=? AND entry_type='payment'").get(paid.order.order_id);
  f.now=Math.max(f.now,recorded.recorded_at);
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

const {createPackageReferralRewardCandidate,settlePackageReferralRewardProtection}=await import(new URL('src/v1.4.4/package-referral-runtime.mjs',ROOT));
const {settleReferralRewardProtection}=await import(new URL('src/v1.3.7/referral-reward-protection-runtime.mjs',ROOT));
const {ensureReferralBonusGrant,applyReferralRewardCompensation}=await import(new URL('src/v1.3.7/referral-bonus-access-runtime.mjs',ROOT));
const {allocatePackageReferralBonusSegments,ensurePackageReferralBonusGrant,claimPackageReferralBonusGrant,
  readPackageReferralBonusDatabaseSource,readPackageReferralBonusClaimDatabaseSource,runPackageReferralBonusMaintenance}=await import(new URL('src/v1.4.4/package-referral-bonus-runtime.mjs',ROOT));
const {getPackageReferralBonusStatus,repairPackageReferralBonusGrants}=await import(new URL('src/v1.4.4/package-referral-bonus-runtime.mjs',ROOT));
const {readLifecycleActorFacts,compileAuthorityAssertions}=await import(new URL('src/v1.4.1/authority-resolver.mjs',ROOT));
const {readVerifiedLifecycleFacts}=await import(new URL('src/v1.4.3/lifecycle-authority.mjs',ROOT));
const {resolveOwnPackagePeriodAuthority,createServerPackageQuote}=await import(new URL('src/v1.4.4/package-contract.mjs',ROOT));
const make=t=>{const f=packageReferralFixture(t,{packageReferralSql:fs.readFileSync(new URL('migrations/0074-v1.4.4-package-referral-compatibility.sql',ROOT),'utf8')});t.mock.timers.enable({apis:['Date'],now:f.now*1000});return f;};
async function actor(f,id){return resolver.resolveActor(await f.context(id,'access.read_own'));}
async function facts(f,id){return readVerifiedLifecycleFacts(readLifecycleActorFacts(await actor(f,id)));}
async function packageReward(f,{inviter=202,producer=true}={}) {
  seedReferralInvitation(f,{buyer:900,inviter});
  const source=producer?await seedPackageViaProducers(f):await seedPackageRows(f);
  const candidate=await createPackageReferralRewardCandidate(f.serverEnv,{orderId:source.orderId,selectedAt:f.now});
  assert.equal(candidate.status,'created',JSON.stringify(candidate));
  const proof=seedFreshPaymentRecheck(f,source);f.now=proof.checkedAt;
  const settled=await settlePackageReferralRewardProtection(f.serverEnv,{rewardId:candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:f.now});
  assert.equal(settled.outcome,'confirmed',JSON.stringify(settled));
  return {...source,rewardId:candidate.rewardId};
}
async function legacyReward(f,{inviter=900}={}) {
  const source=await seedMonthlyCandidateViaProducer(f,{inviter}),proof=seedFreshPaymentRecheck(f,source);f.now=proof.checkedAt;
  const settled=await settleReferralRewardProtection(f.serverEnv,{rewardId:source.candidate.rewardId,reconciliationRunId:proof.runId,checkedAt:f.now});
  assert.equal(settled.outcome,'confirmed',JSON.stringify(settled));
  return {...source,rewardId:source.candidate.rewardId};
}
async function paidBeneficiary(f,{plan='professional',start=f.now,buyer=900}={}) {
  await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:buyer,telegramUpdateId:nextReferralFixtureUpdate(),acceptedAt:f.now-100});
  return seedPackageRows(f,{buyer,plan,startsAt:start});
}
function rowsSnapshot(f,table){return JSON.stringify(f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY 1').all());}
function grantSegments(f,id){return f.sqlite.prepare('SELECT * FROM package_referral_bonus_segments WHERE bonus_grant_id=? ORDER BY segment_index').all(id);}

test('allocator retains exactly72h in earliest free gaps and never rewrites occupied windows',()=>{
 const occupied=[{startsAt:1000,endsAt:2000},{startsAt:2060,endsAt:3000}];
 const before=JSON.stringify(occupied),segments=allocatePackageReferralBonusSegments({planCode:'professional',anchorAt:2000,occupied});
 assert.deepEqual(segments,[{planCode:'professional',startsAt:2000,endsAt:2060,seconds:60},{planCode:'professional',startsAt:3000,endsAt:262140,seconds:259140}]);
 assert.equal(JSON.stringify(occupied),before);assert.equal(segments.reduce((n,s)=>n+s.seconds,0),259200);
});
test('genuine package friend produces manual Professional claim with exact30d window and canonical earned access',async t=>{
 const f=make(t),source=await packageReward(f),granted=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 assert.equal(granted.status,'claimable',JSON.stringify(granted));assert.equal(granted.claimExpiresAt,f.now+2592000);
 assert.equal((await actor(f,202)).access.effectivePlan,'free');
 const wrong=await claimPackageReferralBonusGrant(f.serverEnv,{telegramId:101,bonusGrantId:granted.bonusGrantId,claimedAt:f.now});assert.equal(wrong.status,'not_applicable');
 const claimed=await claimPackageReferralBonusGrant(f.serverEnv,{telegramId:202,bonusGrantId:granted.bonusGrantId,claimedAt:f.now});assert.equal(claimed.status,'applied',JSON.stringify(claimed));
 const own=await actor(f,202);assert.equal(own.access.effectivePlan,'professional');assert.equal(own.access.sourceKind,'referral_bonus');
 assert.equal((await facts(f,202)).periods.filter(p=>p.sourceKind==='referral_bonus').reduce((n,p)=>n+p.endsAt-p.startsAt,0),259200);
 assert.equal(count(f,'bonus_access_grants'),0);assert.equal(count(f,'subscriptions'),0);assert.equal(count(f,'subscription_access_grants'),0);
 assert.equal((await claimPackageReferralBonusGrant(f.serverEnv,{telegramId:202,bonusGrantId:granted.bonusGrantId,claimedAt:f.now})).status,'duplicate');
 f.now=claimed.endsAt;assert.equal((await actor(f,202)).access.effectivePlan,'free');
});
test('claim deadline is inclusive and maintenance expires only a later unclaimed window',async t=>{
 const f=make(t),source=await packageReward(f,{producer:false}),grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 f.now=grant.claimExpiresAt;
 const claim=await readPackageReferralBonusClaimDatabaseSource({db:f.binding,env:f.serverEnv,telegramId:202,nowSec:f.now});assert.equal(claim.claimableByEvidence,true);
 assert.equal((await runPackageReferralBonusMaintenance(f.serverEnv,{recordedAt:f.now})).attempted,0);
 f.now++;assert.equal((await readPackageReferralBonusClaimDatabaseSource({db:f.binding,env:f.serverEnv,telegramId:202,nowSec:f.now})).claimableByEvidence,false);
 assert.equal((await runPackageReferralBonusMaintenance(f.serverEnv,{recordedAt:f.now})).attempted,1);
 assert.equal(f.sqlite.prepare('SELECT grant_status FROM package_referral_bonus_grants').get().grant_status,'expired');
 assert.equal(count(f,'package_referral_bonus_effects'),0);
});
test('legacy friend to genuine current package gets same-plan72h without changing paid package rows',async t=>{
 const f=make(t),source=await legacyReward(f),current=await paidBeneficiary(f,{plan:'dragon'}),paid=rowsSnapshot(f,'subscription_package_periods');
 const grant=await ensureReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});assert.equal(grant.status,'applied',JSON.stringify(grant));assert.equal(grant.planCode,'dragon');
 assert.equal(rowsSnapshot(f,'subscription_package_periods'),paid);assert.equal(count(f,'bonus_access_grants'),0);
 assert.equal(grant.startsAt,current.period.ends_at);assert.equal(grant.endsAt,current.period.ends_at+259200);
 f.now=grant.startsAt;const own=await actor(f,900);assert.equal(own.access.effectivePlan,'dragon');assert.equal(own.access.sourceKind,'referral_bonus');
});
test('already paid future switch before gift pins split72h segments and exact payment history',async t=>{
 const f=make(t),source=await legacyReward(f),current=await paidBeneficiary(f),future=await paidBeneficiary(f,{plan:'dragon',start:current.period.ends_at+60});
 const paid=rowsSnapshot(f,'subscription_package_periods'),ledger=rowsSnapshot(f,'payment_ledger');
 const grant=await ensureReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});assert.equal(grant.status,'applied',JSON.stringify(grant));
 const segments=grantSegments(f,grant.bonusGrantId);assert.equal(segments.length,2);assert.equal(segments[0].starts_at,current.period.ends_at);assert.equal(segments[0].ends_at,future.period.starts_at);
 assert.equal(segments[1].starts_at,future.period.ends_at);assert.equal(segments.reduce((n,s)=>n+s.seconds,0),259200);
 assert.equal(rowsSnapshot(f,'subscription_package_periods'),paid);assert.equal(rowsSnapshot(f,'payment_ledger'),ledger);
 for(const [at,plan] of [[current.period.ends_at,'professional'],[future.period.starts_at,'dragon'],[future.period.ends_at,'professional'],[grant.endsAt,'free']]) {f.now=at;assert.equal((await actor(f,900)).access.effectivePlan,plan);}
});
test('gift first reserves canonical boundary for a later package purchase',async t=>{
 const f=make(t),source=await legacyReward(f),current=await paidBeneficiary(f),grant=await ensureReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 const own=await actor(f,900),verifiedPackagePeriods=await resolveOwnPackagePeriodAuthority({actor:own,nowSec:f.now});
 const quote=createServerPackageQuote({actor:own,verifiedPackagePeriods,nowSec:f.now,request:{requestedPlanCode:'dragon',packageCode:'3m'}});
 assert.equal(quote.quotedStartsAt,current.period.ends_at+259200);assert.equal(quote.quotedStartsAt,grant.endsAt);
});
test('friend refund before earned start revokes only additive entitlement and retains immutable history',async t=>{
 const f=make(t),source=await legacyReward(f),current=await paidBeneficiary(f),grant=await ensureReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 const segments=rowsSnapshot(f,'package_referral_bonus_segments'),effects=rowsSnapshot(f,'package_referral_bonus_effects'),paid=rowsSnapshot(f,'subscription_package_periods');
 const compensation=seedPackageCompensation(f,source,{at:f.now+1});f.now++;
 const result=await applyReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:compensation.ledgerId,recordedAt:f.now});assert.equal(result.status,'applied',JSON.stringify(result));
 assert.equal(f.sqlite.prepare('SELECT grant_status FROM package_referral_bonus_grants').get().grant_status,'revoked');
 assert.equal(rowsSnapshot(f,'package_referral_bonus_segments'),segments);assert.equal(rowsSnapshot(f,'package_referral_bonus_effects'),effects);assert.equal(rowsSnapshot(f,'subscription_package_periods'),paid);
 assert.equal(count(f,'package_referral_bonus_reversals'),1);assert.equal((await facts(f,900)).periods.filter(p=>p.sourceKind==='referral_bonus').length,0);
 f.now=current.period.ends_at;assert.equal((await actor(f,900)).access.effectivePlan,'free');
});
test('package friend refund after gift starts removes residual authority and keeps consumed history',async t=>{
 const f=make(t),source=await packageReward(f),grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 await claimPackageReferralBonusGrant(f.serverEnv,{telegramId:202,bonusGrantId:grant.bonusGrantId,claimedAt:f.now});
 const segments=rowsSnapshot(f,'package_referral_bonus_segments');f.now+=60;
 const compensation=seedPackageCompensation(f,source,{at:f.now});
 await applyReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:compensation.ledgerId,recordedAt:f.now});
 assert.equal(f.sqlite.prepare('SELECT grant_status FROM package_referral_bonus_grants').get().grant_status,'manual_review');
 assert.equal(rowsSnapshot(f,'package_referral_bonus_segments'),segments);assert.equal((await actor(f,202)).access.effectivePlan,'free');
});
test('stale owner authorization rolls entire claim back and later valid claim succeeds once',async t=>{
 const f=make(t),source=await packageReward(f,{producer:false}),grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 await assert.rejects(claimPackageReferralBonusGrant(f.serverEnv,{telegramId:202,bonusGrantId:grant.bonusGrantId,claimedAt:f.now},{additionalAssertions:[{sql:'0',params:[]}]}));
 assert.equal(count(f,'package_referral_bonus_effects'),0);assert.equal(count(f,'package_referral_bonus_segments'),0);
 assert.equal((await claimPackageReferralBonusGrant(f.serverEnv,{telegramId:202,bonusGrantId:grant.bonusGrantId,claimedAt:f.now})).status,'applied');
});
test('refund of an already paid future window after part gift consumed never moves or regrants pinned gift',async t=>{
 const f=make(t),source=await legacyReward(f),current=await paidBeneficiary(f),future=await paidBeneficiary(f,{plan:'dragon',start:current.period.ends_at+60});
 const grant=await ensureReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 const segments=rowsSnapshot(f,'package_referral_bonus_segments'),effects=rowsSnapshot(f,'package_referral_bonus_effects'),paid=rowsSnapshot(f,'subscription_package_periods');
 f.now=current.period.ends_at+30;const before=await actor(f,900),captured=compileAuthorityAssertions(before);
 const compensation=seedPackageCompensation(f,future,{at:f.now});
 await applyReferralRewardCompensation(f.serverEnv,{compensationLedgerEntryId:compensation.ledgerId,recordedAt:f.now});
 const changed=captured.assertions.some(p=>f.sqlite.prepare('SELECT ('+p.sql+') AS ok').get(...p.params).ok!==1);assert.equal(changed,true);
 assert.equal(rowsSnapshot(f,'package_referral_bonus_segments'),segments);assert.equal(rowsSnapshot(f,'package_referral_bonus_effects'),effects);assert.equal(rowsSnapshot(f,'subscription_package_periods'),paid);
 assert.equal((await actor(f,900)).access.effectivePlan,'professional');
 f.now=current.period.ends_at+61;assert.equal((await actor(f,900)).access.effectivePlan,'free');
 f.now=future.period.ends_at;assert.equal((await actor(f,900)).access.effectivePlan,'professional');
 assert.equal(grantSegments(f,grant.bonusGrantId).reduce((n,s)=>n+s.seconds,0),259200);
});
test('actual Telegram callback authorization and fixed own executor claim earned72h while foreign and stale scopes fail',async t=>{
 const f=make(t),source=await packageReward(f),grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 t.mock.timers.setTime(f.now*1000);
 const {createCustomerContext}=await import(new URL('src/v1.4.1/trusted-context.mjs',ROOT));
 const {authorizeTelegramHandler}=await import(new URL('src/v1.4.1/telegram-runtime.mjs',ROOT));
 const {prepareLegacyCompatibility,bindLegacyCompatibilityEnv,executeOwnPackageReferralBonusClaim}=await import(new URL('src/v1.4.1/telegram-legacy-compatibility.mjs',ROOT));
 await assert.rejects(executeOwnPackageReferralBonusClaim(f.serverEnv,{telegramId:202,bonusGrantId:grant.bonusGrantId}),e=>e.code==='untrusted_legacy_compatibility_env');
 const env={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true'},updateId=nextReferralFixtureUpdate(),claim=randomUUID();
 const update={update_id:updateId,callback_query:{id:'offline-bonus-claim-'+updateId,from:{id:202,is_bot:false},message:{from:{id:123456789,is_bot:true},chat:{id:202,type:'private'}},data:'referral_bonus_claim'}};
 f.sqlite.prepare("INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,attempt_count,received_at,lease_expires_at) VALUES(?,'callback_query',202,'processing',?,1,?,?)").run(updateId,claim,f.now,f.now+300);
 const context=await createCustomerContext({binding:f.binding,env,webhookRequest:new Request(env.MINI_APP_ORIGIN+'/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify(update)}),receiptClaimToken:claim,channel:'telegram_callback',operation:'account.menu.read',nowSeconds:f.now});
 const {authorization,handler}=await authorizeTelegramHandler(context,update);
 const bound=bindLegacyCompatibilityEnv(await prepareLegacyCompatibility(authorization,{family:handler.capability}),env);
 await assert.rejects(executeOwnPackageReferralBonusClaim(bound,{telegramId:101,bonusGrantId:grant.bonusGrantId}),e=>e.code==='package_bonus_claim_scope_mismatch');
 await assert.rejects(executeOwnPackageReferralBonusClaim(bound,{telegramId:202,bonusGrantId:randomUUID()}),e=>e.code==='package_bonus_claim_scope_mismatch');
 f.binding.beforeBatch=()=>f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=202').run();
 await assert.rejects(executeOwnPackageReferralBonusClaim(bound,{telegramId:202,bonusGrantId:grant.bonusGrantId}));
 assert.equal(count(f,'package_referral_bonus_effects'),0);assert.equal(count(f,'package_referral_bonus_segments'),0);
 f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=202').run();
 const applied=await executeOwnPackageReferralBonusClaim(bound,{telegramId:202,bonusGrantId:grant.bonusGrantId});assert.equal(applied.status,'applied',JSON.stringify(applied));
 assert.equal((await actor(f,202)).access.effectivePlan,'professional');assert.equal((await facts(f,202)).periods.reduce((n,p)=>n+p.endsAt-p.startsAt,0),259200);
});
test('package friend extends a genuine monthly beneficiary through additive same-plan source without paid-row rewrite',async t=>{
 const f=make(t),source=await packageReward(f),at=f.now-10,id=202;
 const {issueStarsPurchase,handleStarsCommerceUpdate}=await import(new URL('src/v1.3.6/stars-commerce-runtime.mjs',ROOT));
 await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:id,telegramUpdateId:nextReferralFixtureUpdate(),acceptedAt:at-1});
 const calls=[],telegramApi=async(_env,method,payload)=>{calls.push({method,payload});return method==='sendInvoice'?{message_id:nextReferralFixtureUpdate()}:true;};
 const orderId=randomUUID(),issued=await issueStarsPurchase(f.serverEnv,{telegramId:id,requestedPlanCode:'dragon',telegramUpdateId:nextReferralFixtureUpdate(),orderId,createdAt:at},{telegramApi});
 const payload=calls.find(c=>c.method==='sendInvoice').payload.payload;
 const pre=await handleStarsCommerceUpdate(f.serverEnv,{update_id:nextReferralFixtureUpdate(),pre_checkout_query:{id:'offline-package-monthly-'+nextReferralFixtureUpdate(),from:{id,is_bot:false},currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload}},{nowSeconds:at+1,telegramApi});assert.equal(pre.approved,true);
 const paid=await handleStarsCommerceUpdate(f.serverEnv,{update_id:nextReferralFixtureUpdate(),message:{message_id:nextReferralFixtureUpdate(),from:{id,is_bot:false},chat:{id,type:'private'},successful_payment:{currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload,telegram_payment_charge_id:'offline-monthly-beneficiary-'+nextReferralFixtureUpdate(),provider_payment_charge_id:''}}},{nowSeconds:at+2});assert.equal(paid.accessApplied,true);
 const prior=rowsSnapshot(f,'subscription_access_grants'),subscriptions=rowsSnapshot(f,'subscriptions');
 const grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});assert.equal(grant.status,'applied',JSON.stringify(grant));assert.equal(grant.planCode,'dragon');
 assert.equal(rowsSnapshot(f,'subscription_access_grants'),prior);assert.equal(rowsSnapshot(f,'subscriptions'),subscriptions);assert.equal(count(f,'bonus_access_grants'),0);
 f.now=grant.startsAt;assert.equal((await actor(f,id)).access.effectivePlan,'dragon');assert.equal((await actor(f,id)).access.sourceKind,'referral_bonus');
 f.now=grant.endsAt;assert.equal((await actor(f,id)).access.effectivePlan,'free');
});
for(const mode of ['claimable','queued','started']) test(`source refund status is truthful before and after bounded maintenance for ${mode} gift`,async t=>{
 const f=make(t),source=await packageReward(f,{producer:false});
 if(mode==='queued') await paidBeneficiary(f,{buyer:202});
 const grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});
 if(mode==='started') await claimPackageReferralBonusGrant(f.serverEnv,{telegramId:202,bonusGrantId:grant.bonusGrantId,claimedAt:f.now});
 f.now++;
 seedPackageCompensation(f,source,{at:f.now});
 const paid=rowsSnapshot(f,'subscription_package_periods'),ledger=rowsSnapshot(f,'payment_ledger'),effects=rowsSnapshot(f,'package_referral_bonus_effects'),segments=rowsSnapshot(f,'package_referral_bonus_segments');
 const raw=f.sqlite.prepare('SELECT grant_status FROM package_referral_bonus_grants').get().grant_status;
 assert.equal(raw,mode==='claimable'?'claimable':'applied');assert.equal(f.sqlite.prepare('SELECT reward_status FROM package_referral_rewards').get().reward_status,'confirmed');
 const readAudit=f.binding.audit.length,before=await getPackageReferralBonusStatus(f.serverEnv,{telegramId:202,at:f.now});
 const expected=mode==='started'?'manual_review':'revoked';assert.equal(before.status,expected,JSON.stringify(before));assert.equal(before.claimable,false);assert.equal(before.effective,false);assert.equal(before.packageReferralBonus,true);
 assert.equal(f.binding.audit.slice(readAudit).filter(r=>r.mode==='write').length,0);
 assert.equal(f.sqlite.prepare('SELECT grant_status FROM package_referral_bonus_grants').get().grant_status,raw);
 assert.equal((await facts(f,202)).periods.filter(p=>p.sourceKind==='referral_bonus').length,0);
 const maintained=await runPackageReferralBonusMaintenance(f.serverEnv,{limit:1,recordedAt:f.now});assert.equal(maintained.attempted,1);
 assert.equal(f.sqlite.prepare('SELECT reward_status FROM package_referral_rewards').get().reward_status,'cancelled');
 assert.equal(f.sqlite.prepare('SELECT grant_status FROM package_referral_bonus_grants').get().grant_status,expected);
 const after=await getPackageReferralBonusStatus(f.serverEnv,{telegramId:202,at:f.now});assert.equal(after.status,before.status);assert.equal(after.claimable,false);assert.equal(after.effective,false);assert.equal(after.packageReferralBonus,true);
 assert.equal(rowsSnapshot(f,'subscription_package_periods'),paid);assert.equal(rowsSnapshot(f,'payment_ledger'),ledger);assert.equal(rowsSnapshot(f,'package_referral_bonus_effects'),effects);assert.equal(rowsSnapshot(f,'package_referral_bonus_segments'),segments);
 assert.equal((await runPackageReferralBonusMaintenance(f.serverEnv,{limit:1,recordedAt:f.now})).attempted,0);
});
test('first recurring receipt canonical paid start before nominal raw start remains genuine occupied bonus provenance',async t=>{
 const f=make(t),source=await packageReward(f,{inviter:101});t.mock.timers.setTime(f.now*1000);
 const {applyStarsPaidAccess}=await import(new URL('src/v1.3.6/stars-access-runtime.mjs',ROOT));
 const price=f.sqlite.prepare("SELECT * FROM price_book WHERE price_id='dragon-30d-recurring-v1'").get(),created=f.now-100,orderId=randomUUID(),contractId=randomUUID();
 await acceptStarsPurchaseTerms({...f.serverEnv,STARS_TERMS_REVISION:price.terms_revision},{telegramId:101,telegramUpdateId:nextReferralFixtureUpdate(),acceptedAt:created-1});
 const payload=await buildStarsInvoicePayload({invoiceSecret:f.serverEnv.STARS_INVOICE_SECRET,orderId,telegramId:101,priceId:price.price_id});
 f.sqlite.prepare("INSERT INTO subscription_orders(order_id,telegram_id,price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,terms_revision,invoice_payload,order_state,created_at,expires_at,precheckout_approved_at,updated_at) VALUES(?,101,?,1,'dragon','XTR',499,2592000,'recurring',?,?,'precheckout_ok',?,?,?,?)").run(orderId,price.price_id,price.terms_revision,payload,created,f.now+600,created+1,created+1);
 const acceptance=f.sqlite.prepare("SELECT acceptance_id FROM terms_acceptances WHERE telegram_id=101 AND terms_revision=? AND acceptance_scope='stars_purchase'").get(price.terms_revision);
 f.sqlite.prepare("INSERT INTO subscription_billing_contracts(contract_id,telegram_id,plan_code,price_id,origin_order_id,external_invoice_payload,external_payload_sha256,terms_revision,terms_acceptance_id,billing_mode,period_seconds,currency,amount_stars,created_at,updated_at) VALUES(?,101,'dragon',?,?,?,?,?,?,'recurring',2592000,'XTR',499,?,?)").run(contractId,price.price_id,orderId,payload,sha(payload),price.terms_revision,acceptance.acceptance_id,created,created);
 const record=await recordStarsSuccessfulPayment(f.serverEnv,{update_id:nextReferralFixtureUpdate(),message:{message_id:nextReferralFixtureUpdate(),from:{id:101,is_bot:false},chat:{id:101,type:'private'},successful_payment:{currency:'XTR',total_amount:499,invoice_payload:payload,telegram_payment_charge_id:'offline-first31d-'+nextReferralFixtureUpdate(),provider_payment_charge_id:'',is_recurring:true,is_first_recurring:true,subscription_expiration_date:f.now+31*86400}}},{receivedAt:f.now});
 assert.equal((await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId,appliedAt:f.now})).accessApplied,true);
 const raw=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE telegram_id=101').get();assert.equal(raw.starts_at,f.now+86400);
 const before=await facts(f,101),paid=before.periods.find(p=>p.sourceKind==='payment');assert.equal(paid.startsAt,f.now);assert.equal(paid.endsAt,raw.ends_at);
 const history=rowsSnapshot(f,'subscription_access_grants');
 const grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});assert.equal(grant.status,'applied',JSON.stringify(grant));
 assert.equal((await actor(f,101)).access.effectivePlan,'dragon');assert.equal((await facts(f,101)).periods.filter(p=>p.sourceKind==='referral_bonus').reduce((n,p)=>n+p.endsAt-p.startsAt,0),259200);
 f.now=grant.startsAt;assert.equal((await actor(f,101)).access.effectivePlan,'dragon');assert.equal((await actor(f,101)).access.sourceKind,'referral_bonus');assert.equal(rowsSnapshot(f,'subscription_access_grants'),history);
});
test('bounded package bonus repair skips an older ordinary legacy reward and advances a newer genuine package reward',async t=>{
 const f=make(t),older=await legacyReward(f,{inviter:303}),source=await packageReward(f);
 const repaired=await repairPackageReferralBonusGrants(f.serverEnv,{limit:1,deliveredAt:f.now});assert.equal(repaired.attempted,1);assert.equal(repaired.results[0].rewardId,source.rewardId);assert.equal(repaired.results[0].status,'claimable');
 assert.equal(count(f,'bonus_access_grants'),0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM package_referral_bonus_grants WHERE reward_id=?').get(older.rewardId).n,0);
 assert.equal((await repairPackageReferralBonusGrants(f.serverEnv,{limit:1,deliveredAt:f.now})).attempted,0);
});
test('compacted surviving prepaid slice retains canonical and raw immutable bonus provenance after an earlier refund',async t=>{
 const f=make(t),source=await packageReward(f),id=202;
 const {issueStarsPurchase,handleStarsCommerceUpdate}=await import(new URL('src/v1.3.6/stars-commerce-runtime.mjs',ROOT));
 const {applyStarsCompensation}=await import(new URL('src/v1.3.6/stars-access-runtime.mjs',ROOT));
 async function purchase(at) {
   await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:id,telegramUpdateId:nextReferralFixtureUpdate(),acceptedAt:at-1});
   const calls=[],telegramApi=async(_env,method,payload)=>{calls.push({method,payload});return method==='sendInvoice'?{message_id:nextReferralFixtureUpdate()}:true;};
   const orderId=randomUUID(),charge='offline-compact-'+nextReferralFixtureUpdate(),issued=await issueStarsPurchase(f.serverEnv,{telegramId:id,requestedPlanCode:'dragon',telegramUpdateId:nextReferralFixtureUpdate(),orderId,createdAt:at},{telegramApi});
   const payload=calls.find(c=>c.method==='sendInvoice').payload.payload;
   assert.equal((await handleStarsCommerceUpdate(f.serverEnv,{update_id:nextReferralFixtureUpdate(),pre_checkout_query:{id:'offline-compact-query-'+nextReferralFixtureUpdate(),from:{id,is_bot:false},currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload}},{nowSeconds:at+1,telegramApi})).approved,true);
   const result=await handleStarsCommerceUpdate(f.serverEnv,{update_id:nextReferralFixtureUpdate(),message:{message_id:nextReferralFixtureUpdate(),from:{id,is_bot:false},chat:{id,type:'private'},successful_payment:{currency:'XTR',total_amount:issued.amountStars,invoice_payload:payload,telegram_payment_charge_id:charge,provider_payment_charge_id:''}}},{nowSeconds:at+2});assert.equal(result.accessApplied,true);return {orderId,charge};
 }
 const first=await purchase(f.now-20),second=await purchase(f.now-10);
 await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:first.charge,compensationType:'refund',occurredAt:f.now});
 const raw=f.sqlite.prepare('SELECT * FROM subscription_access_grants WHERE order_id=?').get(second.orderId),canonical=(await facts(f,id)).periods.find(p=>p.status==='active'&&p.sourceKind==='payment');
 assert.notEqual(canonical.startsAt,raw.starts_at);assert.notEqual(canonical.endsAt,raw.ends_at);
 const history=rowsSnapshot(f,'subscription_access_grants'),grant=await ensurePackageReferralBonusGrant(f.serverEnv,{rewardId:source.rewardId,deliveredAt:f.now});assert.equal(grant.status,'applied',JSON.stringify(grant));assert.equal(grant.startsAt,canonical.endsAt);
 assert.equal((await facts(f,id)).periods.filter(p=>p.sourceKind==='referral_bonus').reduce((n,p)=>n+p.endsAt-p.startsAt,0),259200);
 f.now=grant.startsAt;assert.equal((await actor(f,id)).access.effectivePlan,'dragon');assert.equal((await actor(f,id)).access.sourceKind,'referral_bonus');assert.equal(rowsSnapshot(f,'subscription_access_grants'),history);
});
