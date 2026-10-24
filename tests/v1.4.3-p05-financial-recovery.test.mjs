import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cabinetSubscriptionFixture, next, TERMS_REVISION, invoiceIntent } from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import { signedInitData } from './helpers/v1.4.1-fixtures.mjs';
import { ORIGIN } from './helpers/v1.4.0-rebuild-sqlite.mjs';
import { materializeV143ReleaseEnv } from '../src/v1.4.3/release-config.mjs';
import { createCabinetHttp, CABINET_API_PREFIX } from '../src/v1.4.0-rebuild/cabinet-http.mjs';
import { createCabinetCustomerContext, createServiceExecutor } from '../src/v1.4.1/trusted-context.mjs';
import { createRuntimeAuthorizer, requireRuntimeAuthorization } from '../src/v1.4.1/runtime-authorizer.mjs';
import { authorizeOwnStarsSubscriptionCommand, authorizeOwnerSubscriptionPaymentReview } from '../src/v1.4.3/subscription-action-authority.mjs';
import { requestStarsRefund, readStarsOperationsConfig } from '../src/v1.3.6/stars-access-runtime.mjs';
import { readStarsCoreConfig } from '../src/v1.3.6/stars-core-foundation.mjs';
import { readStarsRecurringConfig } from '../src/v1.4.3/recurring-provider-config.mjs';
import { runPaidSubscriptionNotifications } from '../src/v1.4.3/subscription-notifications.mjs';

const source='e'.repeat(40), bridge='f'.repeat(64), revision=32;
const legacy={V141_SOURCE_SHA:source,V141_RELEASE_MODE:'owner_only',V141_AUTHORIZATION_ENABLED:'true',V141_LEGACY_COMPATIBILITY_ENABLED:'true'};
const admin={version:'1.4.1.1',sourceSha:source,mode:'owner_only',supportCandidateSha:source,supportBridgeKey:bridge};
const product={version:'1.4.2',sourceSha:source,mode:'owner_only',dragonEmojiEnabled:true};
const config=mode=>({version:'1.4.3',sourceSha:source,mode,recurringEnabled:mode==='owner_only',paidNotificationsEnabled:mode==='owner_only'});
const closedFlags=['STARS_PAYMENTS_ENABLED','STARS_RECURRING_ENABLED','STARS_REFUNDS_ENABLED',
  'STARS_PAID_NOTIFICATIONS_ENABLED','REBUILD_V140_WRITES_ENABLED','V142_DRAGON_EMOJI_ENABLED'];
const pairedEnv=env=>({...env,...legacy,REBUILD_V140_RC_SHA:source,V141_ADMIN_MINI_APP_ENABLED:'true',V141_ADMIN_SUPPORT_CANDIDATE_SHA:source,
  V141_ADMIN_PRODUCT_VERSION:'1.4.1.1',V141_ADMIN_SUPPORT_BRIDGE_KEY:bridge,V142_DRAGON_EMOJI_ENABLED:'true',
  ...Object.fromEntries(closedFlags.map(flag=>[flag,'true']))});
const recoveryEnv=env=>materializeV143ReleaseEnv(pairedEnv(env),config('recovery'),legacy,admin,product);
const count=(f,table)=>f.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function httpFixture(t) {
  const f=cabinetSubscriptionFixture(t);
  f.sqlite.exec(fs.readFileSync(new URL('../migrations/0065-v1.4.1-privacy-ai-journal.sql',import.meta.url),'utf8'));
  for(const table of ['user_plans','user_access_states']) {
    const columns=table==='user_plans'?'plan_code':'access_state', value=table==='user_plans'?'free':'none';
    f.sqlite.prepare(`INSERT OR IGNORE INTO ${table}(telegram_id,${columns},source_code) VALUES(900,?,'system_default')`).run(value);
  }
  f.sqlite.prepare("INSERT INTO mini_app_release_control(id,candidate_sha,revision,state,beta_enabled,updated_at) VALUES(1,?,?,'closed',0,?)")
    .run(source,revision,f.now);
  f.serverEnv=recoveryEnv({...f.serverEnv,REBUILD_V140_RC_SHA:source,REBUILD_V140_RELEASE_REVISION:String(revision),
    REBUILD_V140_RELEASE_LEASE_REQUIRED:'true',REBUILD_V140_ADMIN_ACCESS_ENABLED:'true',REBUILD_V140_OWNER_WINDOW:'false'});
  f.calls=[];
  f.http=createCabinetHttp({repositoryFactory:f.repositoryFactory,clock:()=>Math.max(f.now,Math.floor(Date.now()/1000)),
    nativeProviderFetch:async(url,options)=>{f.calls.push({url,options});throw new Error('recovery must not call a financial provider');}});
  f.request=async(path,{token,body,key='recovery-operation-'+next(),method='POST'}={})=>{
    const headers=new Headers(token?{Authorization:'Bearer '+token}:{});
    if(method==='POST')for(const [name,value] of Object.entries({Origin:ORIGIN,'Content-Type':'application/json',
      'Sec-Fetch-Site':'same-origin','Idempotency-Key':key}))headers.set(name,value);
    const response=await f.http(new Request(ORIGIN+CABINET_API_PREFIX+path,{method,headers,
      ...(method==='POST'?{body:JSON.stringify(body)}:{})}),f.serverEnv);
    return {status:response.status,data:await response.json()};
  };
  f.open=async()=>{
    const result=await f.request('session',{body:{initData:signedInitData(900,Math.max(f.now,Math.floor(Date.now()/1000)))}});
    assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.features.mutationsEnabled,false);
    return result.data.sessionToken;
  };
  f.authorize=async(token,operation,payload,ref=null)=>{
    const context=await createCabinetCustomerContext({binding:f.binding,env:f.serverEnv,sessionToken:token,
      sessionScope:{candidateSha:source,revision},channel:'mini_app',operation,requestPayload:payload,
      idempotencyKey:'recovery-principal-'+next(),nowSeconds:Math.max(f.now,Math.floor(Date.now()/1000))});
    return requireRuntimeAuthorization(await createRuntimeAuthorizer().authorize(context,ref));
  };
  return f;
}

test('compiled recovery closes physical true financial switches while retaining the genuine current authority',()=>{
  const physical=pairedEnv({DB:{},BOT_TOKEN:'offline',STARS_BILLING_MODE:'prepaid'});
  const actual=materializeV143ReleaseEnv(physical,config('recovery'),legacy,admin,product);
  for(const flag of closedFlags){assert.equal(physical[flag],'true',flag);assert.equal(actual[flag],'false',flag);}
  for(const [key,value] of Object.entries(legacy))assert.equal(actual[key],value,key);
  assert.equal(actual.DB,physical.DB);assert.equal(actual.BOT_TOKEN,physical.BOT_TOKEN);
  assert.equal(readStarsCoreConfig(actual).ready,false);assert.equal(readStarsRecurringConfig(actual).ready,false);
  assert.equal(readStarsOperationsConfig(actual).refundsEnabled,false);
  assert.throws(()=>materializeV143ReleaseEnv(physical,config('recovery'),{...legacy,V141_SOURCE_SHA:'a'.repeat(40)},admin,product),
    /v143_recovery_source_pair_unavailable/);
});

test('a genuinely signed owner HTTP session cannot issue invoices, renewal commands, apply paid access or request refunds in recovery',async t=>{
  const f=httpFixture(t),token=await f.open();
  const paths=[['subscription/recurring-invoice',{planCode:'dragon',recurringConsent:true,termsRevision:TERMS_REVISION,priceVersion:1}],
    ['subscription/renewal/cancel',{contractId:'offline-recovery-contract',expectedRevision:1}],
    ['subscription/renewal/enable',{contractId:'offline-recovery-contract',expectedRevision:1}],
    ['admin/subscription-review/apply',{ledgerEntryId:'offline-retained-payment',reasonCode:'payment_support_review'}],
    ['admin/subscription-review/refund',{ledgerEntryId:'offline-retained-payment',reasonCode:'payment_support_review'}]];
  for(const [path,body] of paths){const response=await f.request(path,{token,body});
    assert.equal(response.status,403,path+': '+JSON.stringify(response.data));}
  assert.equal(f.calls.length,0);
  for(const table of ['subscription_orders','subscription_billing_contracts','subscription_invoice_requests',
    'subscription_provider_commands','subscription_payment_review_settlements','payment_refunds','payment_ledger','subscription_access_grants'])
    assert.equal(count(f,table),0,table);
});

test('genuine own and owner read principals remain distinct from private recovery-blocked provider admissions',async t=>{
  const f=httpFixture(t),token=await f.open();
  for(const action of ['cancel_renewal','reenable_renewal']){
    const authorization=await f.authorize(token,'access.read_own',
      {subscriptionAction:action,contractId:'offline-recovery-contract',expectedRevision:1});
    await assert.rejects(authorizeOwnStarsSubscriptionCommand(authorization),{code:'subscription_action_principal_invalid'});
  }
  for(const action of ['apply','refund']){
    const authorization=await f.authorize(token,'admin.cabinet.open',
      {subscriptionReviewAction:action,ledgerEntryId:'offline-retained-payment',reasonCode:'payment_support_review'},
      {kind:'admin_surface',key:'cabinet'});
    await assert.rejects(authorizeOwnerSubscriptionPaymentReview(authorization),{code:'subscription_action_principal_invalid'});
  }
  await assert.rejects(f.authorize(token,'billing.purchase_monthly',invoiceIntent));
  assert.equal(f.calls.length,0);assert.equal(count(f,'payment_ledger'),0);
});

test('legacy owner refunds and genuine historical paid notifications honor the final recovery switch closure',async t=>{
  const f=httpFixture(t);let externalCalls=0;
  await assert.rejects(requestStarsRefund(f.serverEnv,{adminTelegramId:900,telegramPaymentChargeId:'offline-existing-charge',
    reasonCode:'payment_support_review'},{telegramApi:async()=>{externalCalls++;return true;}}),{code:'stars_refunds_disabled'});
  const context=createServiceExecutor({binding:f.binding,env:f.serverEnv,purpose:'notification_deliver_historical'}).createContext();
  const result=await runPaidSubscriptionNotifications(context,{fetchImpl:async()=>{externalCalls++;throw new Error('must stay closed');}});
  assert.equal(result.enabled,false);assert.equal(result.sent,0);assert.equal(externalCalls,0);
  assert.equal(count(f,'payment_refunds'),0);assert.equal(count(f,'paid_subscription_notification_jobs'),0);
});
