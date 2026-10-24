import fs from 'node:fs';
import assert from 'node:assert/strict';
import { foundationFixture,signedInitData } from './v1.4.1-fixtures.mjs';
import { createCustomerContext,createCabinetCustomerContext } from '../../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer,requireRuntimeAuthorization } from '../../src/v1.4.1/runtime-authorizer.mjs';
import { authorizeOwnerSubscriptionPaymentReview } from '../../src/v1.4.3/subscription-action-authority.mjs';
import { issueStarsRecurringInvoice } from '../../src/v1.4.3/telegram-subscription-provider.mjs';
import { STARS_RECURRING_TERMS_REVISION as TERMS } from '../../src/v1.4.3/recurring-provider-config.mjs';
import { acceptStarsPurchaseTerms,issueStarsInvoice,handleStarsPreCheckoutQuery,recordStarsSuccessfulPayment } from '../../src/v1.3.6/stars-payment-runtime.mjs';
import { applyStarsPaidAccess } from '../../src/v1.3.6/stars-access-runtime.mjs';

let seq=1434900;
export const next=()=>++seq,MONTH=2592000,TERMS_REVISION=TERMS;
export const invoiceIntent={action:'accept',requestedPlanCode:'dragon',billingMode:'recurring',recurringConsent:true,
  termsRevision:TERMS,priceVersion:1};
export const invoiceStatusIntent={kind:'invoice',intent:{planCode:'dragon',recurringConsent:true,termsRevision:TERMS,priceVersion:1}};
export function cabinetSubscriptionFixture(t) {
  const f=foundationFixture(t);
  for(const name of ['0026-v1.3.6-stars-core-foundation.sql','0027-v1.3.6-stars-access-and-reconciliation.sql',
    '0066-v1.4.3-subscription-lifecycle-foundation.sql','0067-v1.4.3-lifecycle-engine-binding.sql',
    '0068-v1.4.3-provider-and-review-binding.sql']) f.sqlite.exec(fs.readFileSync(new URL('../../migrations/'+name,import.meta.url),'utf8'));
  f.serverEnv={...f.serverEnv,STARS_PAYMENTS_ENABLED:'true',STARS_BILLING_MODE:'prepaid',STARS_REFUNDS_ENABLED:'true',
    STARS_RECURRING_ENABLED:'true',STARS_RECURRING_PRICE_VERSION:'1',STARS_RECURRING_TERMS_REVISION:TERMS,
    STARS_PRICE_VERSION:'1',STARS_TERMS_REVISION:'2026-09-10.stars-v1',STARS_ROLLOUT_MODE:'all',
    STARS_INVOICE_SECRET:'offline-v143-cabinet-fixture-secret-more-than-32-characters'};
  for(const id of [101,202,303,404]) {
    f.sqlite.prepare("INSERT OR IGNORE INTO user_plans(telegram_id,plan_code,source_code) VALUES(?,'free','system_default')").run(id);
    f.sqlite.prepare("INSERT OR IGNORE INTO user_access_states(telegram_id,access_state,source_code) VALUES(?,'none','system_default')").run(id);
  }
  f.auth=async({id=101,operation='access.read_own',payload={},key='cabinet-operation-'+next()}={})=>{
    if(!f.tokens.has(id)) await f.session(id);
    const context=await createCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:f.tokens.get(id),
      channel:'mini_app',operation,requestPayload:payload,idempotencyKey:key});
    return requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,null));
  };
  f.successful=(order,{expiration=f.now+MONTH,first=true}={})=>({update_id:next(),message:{message_id:next(),
    from:{id:101,is_bot:false},chat:{id:101,type:'private'},successful_payment:{currency:'XTR',
      total_amount:order.amount_stars,invoice_payload:order.invoice_payload,telegram_payment_charge_id:'offline-receipt-'+next(),
      provider_payment_charge_id:'',is_recurring:true,is_first_recurring:first,subscription_expiration_date:expiration}}});
  f.paid=async()=>{
    const invoice=await issueStarsRecurringInvoice(await f.auth({operation:'billing.purchase_monthly',payload:invoiceIntent}),
      {telegramApi:async()=> 'https://t.me/$offlineHistoryFixture'});
    const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
    const checkout=await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:next(),pre_checkout_query:{id:'offline-'+next(),
      from:{id:101,is_bot:false},currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload}},
      {telegramApi:async()=>true});assert.equal(checkout.approved,true);
    const update=f.successful(order),record=await recordStarsSuccessfulPayment(f.serverEnv,update);
    assert.equal((await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId})).accessApplied,true);
    return {invoice,order,record,update,contract:f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId)};
  };
  f.retained=async()=>{
    const paid=await f.paid();
    await acceptStarsPurchaseTerms(f.serverEnv,{telegramId:101,telegramUpdateId:next()});
    await issueStarsInvoice(f.serverEnv,{telegramId:101,requestedPlanCode:'dragon',telegramUpdateId:next()},
      {telegramApi:async()=>({message_id:next()})});
    f.sqlite.prepare('UPDATE users SET is_blocked=1 WHERE telegram_id=101').run();
    const update=f.successful(paid.order,{expiration:f.now+MONTH+500,first:false});
    const record=await recordStarsSuccessfulPayment(f.serverEnv,update);
    assert.equal(record.status,'manual_review');
    f.sqlite.prepare('UPDATE users SET is_blocked=0 WHERE telegram_id=101').run();
    return {...paid,retained:record,retainedUpdate:update};
  };
  f.owner=async()=>{
    f.now=Math.max(f.now,Math.floor(Date.now()/1000));const candidate='d'.repeat(40),revision=32;
    f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)").run(candidate,revision,f.now);
    const env={...f.serverEnv,V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_ADMIN_MINI_APP_ENABLED:'true',
      REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_OWNER_WINDOW:'false',
      REBUILD_V140_RC_SHA:candidate,REBUILD_V140_RELEASE_REVISION:String(revision),REBUILD_V140_WRITES_ENABLED:'true'};
    const opened=await f.call(900,'session',{method:'POST',token:null,payload:{initData:signedInitData(900,f.now)},customEnv:env});
    assert.equal(opened.status,200,JSON.stringify(opened.data));
    return async(ledgerEntryId,action='apply')=>{
      const context=await createCabinetCustomerContext({binding:f.binding,env,sessionToken:opened.data.sessionToken,
        sessionScope:{candidateSha:candidate,revision},channel:'mini_app',operation:'admin.cabinet.open',
        requestPayload:{subscriptionReviewAction:action,ledgerEntryId,reasonCode:'payment_support_review'},
        idempotencyKey:'owner-review-'+next(),nowSeconds:f.now});
      return authorizeOwnerSubscriptionPaymentReview(await createRuntimeAuthorizer().authorize(context,{kind:'admin_surface',key:'cabinet'}));
    };
  };
  return f;
}
