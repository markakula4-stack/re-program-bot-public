import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foundationFixture, signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { authoritySeconds, createAuthorityResolver } from '../src/v1.4.1/authority-resolver.mjs';
import { createCustomerContext, createCabinetCustomerContext, createFinancialCustomerContext } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, assertRuntimeAuthorizationFresh } from '../src/v1.4.1/runtime-authorizer.mjs';
import { acceptStarsPurchaseTerms, handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsCompensation } from '../src/v1.3.6/stars-access-runtime.mjs';
import { issuePackageInvoice } from '../src/v1.4.4/package-payment-runtime.mjs';
import { executePackageCommerceCommand } from '../src/v1.4.4/package-commerce-runtime.mjs';
import { PACKAGE_DURATIONS, PACKAGE_CANONICAL_PRICES } from '../src/v1.4.4/package-contract.mjs';
import { readOwnPackageSubscription } from '../src/v1.4.4/package-read-model.mjs';
import { readSubscriptionData } from '../src/v1.4.2/subscription-read-model.mjs';
import { createCabinetHttpRuntime } from '../src/v1.4.1/http-runtime.mjs';
import { projectOwnSubscriptionHistory } from '../src/v1.4.3/subscription-history.mjs';
const resolver = createAuthorityResolver();
let sequence = 2446000;
const next = () => ++sequence;
const stamp = seconds => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
function fixture(t, patch = {}) {
  const f = foundationFixture(t);
  t.mock.timers.enable({apis:['Date'],now:f.now*1000});
  f.sqlite.function('current_timestamp', { deterministic: false }, () => stamp(f.now));
  f.sqlite.function('unixepoch', { deterministic: false, varargs: true }, (...args) =>
    !args.length || args[0] === 'now' ? f.now : authoritySeconds(args[0]));
  for (const name of ['0026-v1.3.6-stars-core-foundation.sql', '0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql', '0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql', '0069-v1.4.3-d1-compatibility.sql',
    '0070-v1.4.3-refund-notification.sql', '0071-v1.4.3-refund-contract-retirement.sql',
    '0072-v1.4.4-package-contract.sql', '0073-v1.4.4-package-payment-review.sql'])
    f.sqlite.exec(fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  f.serverEnv = { ...f.serverEnv, WEBHOOK_SECRET: 'offline-v144-bot-transport-secret', STARS_PAYMENTS_ENABLED: 'true',
    STARS_BILLING_MODE: 'prepaid', STARS_PRICE_VERSION: '1', STARS_TERMS_REVISION: '2026-09-10.stars-v1',
    STARS_RECURRING_ENABLED: 'true', STARS_INVOICE_SECRET: 'offline-v144-bot-invoice-secret-longer-than-32-characters',
    STARS_ROLLOUT_MODE: 'allowlist', STARS_ROLLOUT_ALLOWLIST: '900', STARS_PACKAGES_ENABLED: 'true',
    STARS_PACKAGE_3M_ENABLED: 'true', ...patch };
  for (const plan of ['professional', 'dragon']) for (const [code, period] of Object.entries(PACKAGE_DURATIONS))
    f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,
      access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at)
      VALUES(?,1,?,'XTR',?,?,'prepaid','approved',?,?,?)`).run(`${plan}-${period.durationDays}d-prepaid-v1`,
        plan, PACKAGE_CANONICAL_PRICES[plan][code], period.periodSeconds, f.serverEnv.STARS_TERMS_REVISION,
        f.now - 10000, f.now - 10000);
  for (const id of [101, 900]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  return f;
}
async function financial(f, update) {
  const token = 'offline-v144-financial-claim-' + update.update_id;
  f.sqlite.prepare(`INSERT INTO telegram_update_receipts(update_id,update_type,actor_id,status,claim_token,
    received_at,lease_expires_at) VALUES(?,'message',900,'processing',?,?,?)`)
    .run(update.update_id, token, f.now, f.now + 60);
  const context = await createFinancialCustomerContext({ binding: f.binding, env: f.serverEnv,
    webhookRequest: new Request(f.serverEnv.MINI_APP_ORIGIN + '/webhook', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': f.serverEnv.WEBHOOK_SECRET }, body: JSON.stringify(update) }),
    receiptClaimToken: token, nowSeconds: f.now });
  return { packageFinancialContext: context, packageActor: await resolver.resolveActor(context) };
}
async function paidPackage(f, plan = 'professional', code = '3m') {
  await acceptStarsPurchaseTerms(f.serverEnv, { telegramId: 900, telegramUpdateId: next(), acceptedAt: f.now - 1 });
  const actor = await resolver.resolveActor(await f.context(900, 'access.read_own'));
  const telegramApi = async (_env, method) => method === 'createInvoiceLink' ? 'https://t.me/$offlinePackageBot-' + next() : true;
  const invoice = await issuePackageInvoice({ actor, request: { requestedPlanCode: plan, packageCode: code },
    telegramUpdateId: next(), createdAt: f.now }, { telegramApi });
  const order = f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
  const checkout = { update_id: next(), pre_checkout_query: { id: 'offline-package-query-' + sequence,
    from: { id: 900, is_bot: false }, currency: 'XTR', total_amount: order.amount_stars, invoice_payload: order.invoice_payload } };
  assert.equal((await handleStarsPreCheckoutQuery(f.serverEnv, checkout, {
    nowSeconds: f.now, ...await financial(f, checkout), telegramApi })).approved, true);
  const update = { update_id: next(), message: { message_id: next(), date: f.now, from: { id: 900, is_bot: false },
    chat: { id: 900, type: 'private' }, successful_payment: { currency: 'XTR', total_amount: order.amount_stars,
      invoice_payload: order.invoice_payload, telegram_payment_charge_id: 'offline-package-bot-charge-' + next(), provider_payment_charge_id: '' } } };
  const payment = await recordStarsSuccessfulPayment(f.serverEnv, update, { receivedAt: f.now, ...await financial(f, update) });
  assert.equal(payment.status, 'recorded');
  return { order, payment, charge: update.message.successful_payment.telegram_payment_charge_id };
}

async function auth(f,id=900,operation='access.read_own') {
 const authorization=await createRuntimeAuthorizer().authorize(await f.context(id,operation));
 await assertRuntimeAuthorizationFresh(authorization);return authorization;
}
async function read(f,id=900){return readOwnPackageSubscription({authorization:await auth(f,id)});}
async function command(f,operation,payload){if(!f.tokens.has(900))await f.session(900);return executePackageCommerceCommand(await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(900),
 channel:'mini_app',operation:'access.read_own',nowSeconds:f.now,requestPayload:payload,idempotencyKey:'offline-read-model-command-'+next()}),operation);}
const cash=f=>JSON.stringify(['payment_ledger','subscription_orders','subscription_package_periods','subscription_plan_transitions',
 'subscription_billing_contracts','subscription_provider_commands'].map(table=>f.sqlite.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()));
const forbidden=/(sourceFingerprint|sourcePaymentLedgerEntryId|sourceSubscriptionId|sourcePackagePeriodId|chargeId|invoice_payload|telegramId|orderId|ledgerEntryId)/u;
const offer=(view,plan='professional',code='3m')=>view.offers.find(row=>row.planCode===plan&&row.packageCode===code);

test('genuine own package catalog projects canonical ninety-day prices and only published comparison without writes',async t=>{
 const f=fixture(t),before=cash(f),authorization=await auth(f);f.binding.audit.length=0;
 const view=await readOwnPackageSubscription({authorization}),pro=offer(view),dragon=offer(view,'dragon');
 assert.equal(view.available,true);assert.equal(view.authority,'worker');assert.equal(view.accessAuthority,false);
 assert.equal(view.canWrite,false);assert.equal(pro.amountStars,699);assert.equal(dragon.amountStars,1399);
 assert.deepEqual(pro.priceComparison,{amountStars:747,monthlyAmountStars:249,periodCount:3,basis:'same_plan_monthly_equivalent',currency:'XTR'});
 assert.equal(pro.preview.endsAt-pro.preview.startsAt,90*86400);assert.equal(pro.preview.datesAreEstimate,true);
 assert.equal(pro.automaticRenewal,false);assert.equal(pro.invoice.available,false);assert.equal(pro.invoice.reasonCode,'cabinet_session_required');
 assert.equal(cash(f),before);assert.deepEqual(f.binding.audit.filter(row=>row.mode!=='read'||!/^\s*SELECT\b/iu.test(row.sql)),[]);
 assert.doesNotMatch(JSON.stringify(view),forbidden);assert.ok(Object.isFrozen(pro));assert.equal(Object.hasOwn(pro.priceComparison,'savings'),false);
});

test('default-closed six and twelve packages cannot advertise purchase despite existing price rows',async t=>{
 const f=fixture(t);let view=await read(f);
 for(const plan of ['professional','dragon'])for(const code of ['6m','12m']){
  const row=offer(view,plan,code);assert.equal(row.available,false);assert.equal(row.amountStars,null);assert.equal(row.invoice.available,false);
 }
 f.serverEnv={...f.serverEnv,STARS_PACKAGE_6M_ENABLED:'true',STARS_PACKAGE_12M_ENABLED:'true'};view=await read(f);
 assert.equal(offer(view,'professional','6m').reasonCode,'package_economics_and_refund_evidence_required');
 f.serverEnv={...f.serverEnv,STARS_PACKAGE_ECONOMICS_EVIDENCE_SHA256:'a'.repeat(64),STARS_PACKAGE_REFUND_EVIDENCE_SHA256:'b'.repeat(64)};
 view=await read(f);assert.equal(offer(view,'professional','6m').amountStars,1299);assert.equal(offer(view,'dragon','12m').amountStars,4499);
});

test('nonowner, fabricated authorization and extra requested subject never acquire own package view',async t=>{
 const f=fixture(t),view=await read(f,101);assert.equal(view.available,false);assert.equal(view.offers.length,0);assert.equal(view.reasonCode,'package_owner_authority_required');
 await assert.rejects(()=>readOwnPackageSubscription({authorization:{allowed:true}}),{code:'untrusted_runtime_authorization'});
 await assert.rejects(async()=>readOwnPackageSubscription({authorization:await auth(f),telegramId:101}),{code:'package_read_scope_invalid'});
 await assert.rejects(async()=>readOwnPackageSubscription({authorization:await auth(f,900,'profile.read_own')}),{code:'package_read_scope_invalid'});
});

test('published monthly equivalent vanishes for missing version, draft or expired canonical monthly price',async t=>{
 const f=fixture(t,{STARS_PRICE_VERSION:'2'});assert.equal(offer(await read(f)).priceComparison,null);
 f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,
 publication_state,terms_revision,valid_from,valid_until,created_at) VALUES('professional-30d-prepaid-v2',2,'professional','XTR',249,2592000,
 'prepaid','draft',?, ?,NULL,?)`).run(f.serverEnv.STARS_TERMS_REVISION,f.now-100,f.now-100);
 assert.equal(offer(await read(f)).priceComparison,null);
 f.serverEnv.STARS_PRICE_VERSION='3';
 f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,
 publication_state,terms_revision,valid_from,valid_until,created_at) VALUES('professional-30d-prepaid-v3',3,'professional','XTR',249,2592000,
 'prepaid','approved',?, ?,?,?)`).run(f.serverEnv.STARS_TERMS_REVISION,f.now-100,f.now,f.now-100);
 assert.equal(offer(await read(f)).priceComparison,null);
});

test('actual paid packages keep current and paid future receipts separate until exact boundary',async t=>{
 const f=fixture(t),first=await paidPackage(f),second=await paidPackage(f,'dragon'),before=cash(f);
 let data=await readSubscriptionData({authorization:await auth(f)});
 assert.equal(data.access.current.planCode,'professional');assert.equal(data.packages.paidPeriods.find(row=>row.planCode==='professional').state,'current');
 const future=data.packages.paidPeriods.find(row=>row.planCode==='dragon');assert.equal(future.state,'future');assert.equal(future.startsAt,first.payment.periodEndsAt);
 assert.equal(future.endsAt-future.startsAt,90*86400);assert.equal(future.grantsCurrentAccess,false);
 const receipt=data.history.items.find(row=>row.receiptId===future.receiptId).receipt;
 assert.equal(receipt.package.accessState,'future');assert.equal(receipt.package.startsAt,future.startsAt);
 assert.doesNotMatch(JSON.stringify(data.packages),forbidden);assert.equal(cash(f),before);
 f.now=future.startsAt;t.mock.timers.setTime(f.now*1000);data=await readSubscriptionData({authorization:await auth(f)});
 assert.equal(data.access.current.planCode,'dragon');assert.equal(data.packages.paidPeriods.find(row=>row.receiptId===future.receiptId).state,'current');
 assert.equal(data.packages.paidPeriods.find(row=>row.receiptId===future.receiptId).grantsCurrentAccess,true);
 assert.equal(data.history.items.find(row=>row.receiptId===future.receiptId).receipt.package.accessState,'current');
 assert.equal(second.payment.periodStartsAt,future.startsAt);
});

test('disabled offer flags preserve exact already paid historical package receipts and current source',async t=>{
 const f=fixture(t);await paidPackage(f);f.serverEnv={...f.serverEnv,STARS_PACKAGES_ENABLED:'false',STARS_PACKAGE_3M_ENABLED:'false'};
 const view=await read(f);assert.equal(view.available,false);assert.equal(view.reasonCode,'package_disabled');assert.equal(view.paidPeriods[0].state,'current');
 assert.equal(view.paidPeriods[0].amountStars,699);assert.ok(view.offers.every(row=>row.invoice.available===false));
});

test('exact future refund changes only its own receipt metadata without compacting later independently paid dates',async t=>{
 const f=fixture(t);await paidPackage(f);const second=await paidPackage(f,'dragon'),third=await paidPackage(f),start=third.payment.periodStartsAt;
 const refunded=await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:second.charge,compensationType:'refund',reasonCode:'offline_exact_package_refund',occurredAt:f.now});
 assert.ok(refunded);const data=await readSubscriptionData({authorization:await auth(f)});
 const reversed=data.packages.paidPeriods.find(row=>row.planCode==='dragon');assert.equal(reversed.state,'refunded');assert.equal(reversed.grantsCurrentAccess,false);
 assert.equal(data.history.items.find(row=>row.receiptId===reversed.receiptId).receipt.package.accessState,'refunded');
 assert.ok(data.packages.paidPeriods.some(row=>row.startsAt===start&&row.state==='future'));assert.equal(data.access.current.planCode,'professional');
});

test('unpaid long transition never becomes a paid future receipt and cancellation preserves current cash',async t=>{
 const f=fixture(t);await paidPackage(f);const scheduled=await command(f,'schedule',{requestedPlanCode:'dragon',packageCode:'3m'}),before=cash(f);
 const view=await read(f);assert.equal(view.paidPeriods.length,1);assert.equal(view.transitions.length,1);
 assert.equal(view.transitions[0].state,'scheduled');assert.equal(view.transitions[0].grantsAccess,false);assert.equal(view.transitions[0].effectiveAt,view.paidPeriods[0].endsAt);
 assert.equal(cash(f),before);
 await command(f,'cancel',{transitionId:scheduled.transition.transitionId,expectedRevision:scheduled.transition.revision});
 const closed=await read(f);assert.equal(closed.transitions[0].state,'cancelled');assert.equal(closed.paidPeriods[0].state,'current');
 assert.equal(closed.transitions[0].cancel.available,false);
});

test('monthly boundary view requires fresh consent and closes overdue reservation without claiming a charge',async t=>{
 const f=fixture(t);await paidPackage(f);const scheduled=await command(f,'schedule',{requestedPlanCode:'dragon',packageCode:'30d'});
 let view=await read(f),transition=view.transitions[0];assert.equal(transition.packageCode,'30d');assert.equal(transition.monthlyCheckout.freshConsentRequired,true);
 assert.equal(transition.status,'scheduled');assert.equal(transition.monthlyCheckout.available,false);
 f.now=scheduled.transition.effectiveAt+901;t.mock.timers.setTime(f.now*1000);view=await read(f);transition=view.transitions[0];
 assert.equal(transition.status,'expired_reservation');assert.equal(transition.monthlyCheckout.available,false);
 assert.equal(transition.monthlyCheckout.reasonCode,'monthly_reservation_expired_or_closed');assert.equal(view.paidPeriods[0].state,'expired');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_ledger WHERE entry_type='payment'").get().n,1);
});

test('damaged additive package schema closes offer actions while accepted old own history remains readable',async t=>{
 const f=fixture(t);f.sqlite.exec('DROP TRIGGER v144_package_order_no_delete');const view=await read(f);
 assert.equal(view.available,false);assert.equal(view.offers.length,0);assert.match(view.reasonCode,/package/u);
});

test('a price changed between captured read and final source check rejects stale offer data',async t=>{
 const f=fixture(t),authorization=await auth(f),original=f.binding.batch.bind(f.binding);let changed=false;
 f.binding.batch=async statements=>{if(!changed){changed=true;
  f.sqlite.prepare(`INSERT INTO price_book(price_id,price_version,plan_code,currency,amount_stars,access_seconds,billing_mode,publication_state,terms_revision,valid_from,created_at) VALUES('professional-90d-prepaid-v2',2,'professional','XTR',699,7776000,'prepaid','approved',?,?,?)`).run(f.serverEnv.STARS_TERMS_REVISION,f.now-100,f.now-100);}
  return original(statements);};
 await assert.rejects(()=>readOwnPackageSubscription({authorization}),{code:'package_read_stale'});assert.equal(changed,true);
});


test('confirmed own pending long invoice recovers its genuine URL and estimates without payment authority',async t=>{
 const f=fixture(t);await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:900,telegramUpdateId:next(),acceptedAt:f.now-1});
 const actor=await resolver.resolveActor(await f.context(900,'access.read_own'));
 const invoice=await issuePackageInvoice({actor,request:{requestedPlanCode:'professional',packageCode:'3m'},telegramUpdateId:next(),createdAt:f.now},
 {telegramApi:async()=> 'https://t.me/$actualOwnPendingReadModel'});
 const before=cash(f),view=await read(f);assert.equal(view.pendingInvoices.length,1);
 const pending=view.pendingInvoices[0];assert.equal(pending.invoiceUrl,invoice.invoiceURL);assert.equal(pending.state,'issued');assert.equal(pending.amountStars,699);
 assert.equal(pending.grantsAccess,false);assert.equal(pending.datesAreEstimate,true);assert.equal(view.paidPeriods.length,0);assert.equal(cash(f),before);
 assert.doesNotMatch(JSON.stringify(pending),forbidden);
 f.now=invoice.expiresAt;t.mock.timers.setTime(f.now*1000);const expired=await read(f);
 assert.equal(expired.pendingInvoices[0].state,'expired');assert.equal(expired.pendingInvoices[0].invoiceUrl,null);
});

test('unknown pending long invoice keeps a manual-review description without invented URL or automatic resend',async t=>{
 const f=fixture(t);await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:900,telegramUpdateId:next(),acceptedAt:f.now-1});
 const actor=await resolver.resolveActor(await f.context(900,'access.read_own'));
 await assert.rejects(()=>issuePackageInvoice({actor,request:{requestedPlanCode:'professional',packageCode:'3m'},telegramUpdateId:next(),createdAt:f.now},
 {telegramApi:async()=>{throw Object.assign(new Error('offline lost provider acknowledgement'),{code:'offline_acknowledgement_lost',ambiguous:true});}}));
 const view=await read(f);assert.equal(view.pendingInvoices[0].state,'manual_review');assert.equal(view.pendingInvoices[0].invoiceUrl,null);
 assert.equal(view.pendingInvoices[0].grantsAccess,false);assert.equal(view.paidPeriods.length,0);
});

test('genuine closed owner-session HTTP subscription read stays within its original finite query budget and permits fresh explicit terms',async t=>{
 const f=fixture(t),candidate='e'.repeat(40),revision=17;
 f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)")
 .run(candidate,revision,f.now);
 f.serverEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
 REBUILD_V140_OWNER_WINDOW:'false',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision)};
 const response=await f.call(900,'session',{method:'POST',token:null,payload:{initData:signedInitData(900,f.now)},customEnv:f.serverEnv});
 assert.equal(response.status,200,JSON.stringify(response.data));
 const runtime=createCabinetHttpRuntime({env:f.serverEnv,sessionToken:response.data.sessionToken,sessionScope:{candidateSha:candidate,revision},nowSeconds:f.now});
 f.binding.audit.length=0;const data=await runtime.readSubscription(),pro=offer(data.packages);
 assert.equal(data.packages.canWrite,true);assert.equal(pro.terms.accepted,false);assert.equal(pro.terms.available,true);
 assert.equal(pro.invoice.available,true);assert.equal(pro.amountStars,699);
 assert.ok(data.packages.validUntil<=data.authorization.validUntil);assert.ok(pro.preview.validUntil<=data.packages.validUntil);
 const firstReads=f.binding.audit.filter(row=>row.mode==='read').length;
 assert.ok(firstReads<160,'original read admission budget remains finite');
 assert.equal(data.access.current.planCode,'free');
 await paidPackage(f);await paidPackage(f,'dragon');f.binding.audit.length=0;
 const paidRuntime=createCabinetHttpRuntime({env:f.serverEnv,sessionToken:response.data.sessionToken,
 sessionScope:{candidateSha:candidate,revision},nowSeconds:f.now});
 const paid=await paidRuntime.readSubscription(),paidReads=f.binding.audit.filter(row=>row.mode==='read').length;
 assert.equal(paid.access.current.planCode,'professional');assert.equal(paid.packages.paidPeriods.length,2);
 t.diagnostic(`paid packages availability=${paid.packages.available}, reason=${paid.packages.reasonCode}, offers=${paid.packages.offers.length}, raw SQL=${paidReads}`);
 assert.equal(paid.packages.available,true);assert.equal(offer(paid.packages).amountStars,699);assert.ok(paidReads<=160);
 t.diagnostic(`own HTTP query counts: Free=${firstReads}, current+future=${paidReads}, budget=160`);
 await paidPackage(f);f.binding.audit.length=0;
 const queued=await createCabinetHttpRuntime({env:f.serverEnv,sessionToken:response.data.sessionToken,
 sessionScope:{candidateSha:candidate,revision},nowSeconds:f.now}).readSubscription();
 const queueReads=f.binding.audit.filter(row=>row.mode==='read').length;
 assert.equal(queued.packages.available,true);assert.equal(queued.packages.paidPeriods.length,3);assert.ok(queueReads<=160);
 t.diagnostic(`own HTTP third paid package query count=${queueReads}, budget=160`);
});


test('fresh confirmed UI envelope records own terms once and GET recovers exact immutable confirmation journal hash',async t=>{
 const f=fixture(t),candidate='f'.repeat(40),revision=19;
 f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)").run(candidate,revision,f.now);
 f.serverEnv={...f.serverEnv,V141_AUTHORIZATION_ENABLED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',
 REBUILD_V140_OWNER_WINDOW:'false',REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision)};
 const opened=await f.call(900,'session',{method:'POST',token:null,payload:{initData:signedInitData(900,f.now)},customEnv:f.serverEnv});
 assert.equal(opened.status,200);const sessionScope={candidateSha:candidate,revision};
 const readRuntime=()=>createCabinetHttpRuntime({env:f.serverEnv,sessionToken:opened.data.sessionToken,sessionScope,nowSeconds:f.now});
 const initial=await readRuntime().readSubscription(),selected=offer(initial.packages);
 assert.match(selected.terms.text,/699 Stars за 90 дней/u);assert.match(selected.terms.text,/Возврат не обещается автоматически/u);
 assert.match(selected.terms.text,/после подтверждённой оплаты Telegram/u);assert.match(selected.terms.text,/Неоплаченное запланированное изменение не выдаёт доступ/u);
 const payload={requestedPlanCode:selected.planCode,packageCode:selected.packageCode,confirmation:{acceptedTerms:true,amountStars:selected.amountStars,
 currency:selected.currency,priceVersion:selected.priceVersion,offerVersion:selected.offerVersion,campaignCode:selected.campaignCode,termsRevision:selected.termsRevision}};
 const context=await createCabinetCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:opened.data.sessionToken,sessionScope,
 channel:'mini_app',operation:'access.read_own',nowSeconds:f.now,requestPayload:payload,idempotencyKey:'offline-ui-confirmed-recovery-'+next()});
 let calls=0;const invoice=await executePackageCommerceCommand(context,'invoice',{telegramApi:async(_env,method)=>{
 assert.equal(method,'createInvoiceLink');calls++;return 'https://t.me/$exactFirstUIConfirmedRecovery';}});
 assert.equal(calls,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM terms_acceptances WHERE telegram_id=900').get().n,1);
 const recovered=await readRuntime().readSubscription();assert.equal(recovered.packages.pendingInvoices[0].invoiceUrl,invoice.invoiceURL);
 assert.equal(recovered.packages.pendingInvoices[0].state,'issued');assert.equal(recovered.packages.pendingInvoices[0].grantsAccess,false);
 assert.equal(recovered.access.current.planCode,'free');assert.equal(recovered.packages.paidPeriods.length,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
});

test('genuine current Dragon package enables only registered emoji while paid future and refund stay ineligible',async t=>{
 const f=fixture(t,{V142_DRAGON_EMOJI_ENABLED:'true'});await paidPackage(f);const dragon=await paidPackage(f,'dragon');
 let data=await readSubscriptionData({authorization:await auth(f)});
 assert.equal(data.catalog.nativeDependencies.dragonEmoji.available,false);assert.equal(data.access.current.planCode,'professional');
 f.now=dragon.payment.periodStartsAt;t.mock.timers.setTime(f.now*1000);data=await readSubscriptionData({authorization:await auth(f)});
 assert.equal(data.access.current.planCode,'dragon');assert.equal(data.catalog.nativeDependencies.dragonEmoji.available,true);
 assert.ok(data.catalog.nativeDependencies.dragonEmoji.customEmojiId);
 await applyStarsCompensation(f.serverEnv,{telegramPaymentChargeId:dragon.charge,compensationType:'refund',occurredAt:f.now});
 data=await readSubscriptionData({authorization:await auth(f)});assert.equal(data.catalog.nativeDependencies.dragonEmoji.available,false);
});

test('expired genuine Dragon package loses registered emoji alongside paid access',async t=>{
 const g=fixture(t,{V142_DRAGON_EMOJI_ENABLED:'true'}),paid=await paidPackage(g,'dragon');let data;
 g.now=paid.payment.periodEndsAt;t.mock.timers.setTime(g.now*1000);data=await readSubscriptionData({authorization:await auth(g)});
 assert.equal(data.catalog.nativeDependencies.dragonEmoji.available,false);assert.equal(data.access.current.planCode,'free');
});
