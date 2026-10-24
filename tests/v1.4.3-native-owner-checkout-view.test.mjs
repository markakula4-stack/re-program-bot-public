import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {cabinetSubscriptionFixture} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {readSubscriptionData} from '../src/v1.4.2/subscription-read-model.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {MiniAppClient} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import {mountCabinet} from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
import {createTelegramNativeAdapter} from '../src/v1.4.0-rebuild/mini-app/telegram-native.mjs';

const requireDom=createRequire(process.env.CABINET_UI_DOM_ROOT
  ?`${process.env.CABINET_UI_DOM_ROOT}/package.json`:new URL('./p08-ui/package.json',import.meta.url));
const {parseHTML}=requireDom('linkedom');
const html=fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const actualNow=Date.now;
const invoiceUrl='https://t.me/$offline_correlated_invoice';
const features={version:1,mutationsEnabled:false,offerActionsEnabled:false,nativeOwnerInvoiceOnly:true};

async function fixture(t,{lostResponse=false,recoveryState='confirmed'}={}){
  Date.now=actualNow;
  const f=cabinetSubscriptionFixture(t);f.now=Math.floor(actualNow()/1000);
  Date.now=()=>f.now*1000;t.after(()=>{Date.now=actualNow;});
  const subscription=async()=>{
    const authorization=await f.auth();
    return {...await readSubscriptionData({authorization}),authorization:runtimeAuthorizationDTO(authorization),features};
  };
  let descriptor=await subscription();
  const invoiceAuthorization=runtimeAuthorizationDTO(await f.auth({operation:'billing.purchase_monthly',payload:{action:'accept',
    requestedPlanCode:'dragon',billingMode:'recurring',recurringConsent:true,termsRevision:'2026-10-03.stars-recurring-v1',priceVersion:1}}));
  const profileAuthorization=runtimeAuthorizationDTO(await f.auth({operation:'profile.read_own'}));
  const bootstrap={readModelVersion:1,authorization:profileAuthorization,features,systemRole:'user',
    partner:{state:'no_application',application:null,profile:null,legalProfile:null,beta:null,actions:{}},
    navigation:['profile','offers','applications','analytics','subscription'].map(section=>({section,enabled:section!=='analytics',reason:null})),
    counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
  const calls=[],values=new Map(),sdkCalls=[];let closeInvoice=null,app;
  const sdk={version:'6.1',isVersionAtLeast:()=>true,openInvoice(url,callback){sdkCalls.push(url);closeInvoice=callback;}};
  const client=new MiniAppClient({origin:'https://cabinet.example',now:()=>f.now*1000,
    pendingStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
    onExpired:()=>app?.expire(),fetchImpl:async(url,init)=>{
      calls.push({url,init});
      if(url.endsWith('/session'))return Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',
        expiresAt:f.now+300,principal:{telegramId:101,botId:123456789},authorizationVersion:1,features});
      if(init.method==='GET')return Response.json(url.endsWith('/bootstrap')?bootstrap:descriptor);
      if(url.endsWith('/operation-status'))return Response.json({authority:'worker',kind:'invoice',state:recoveryState,
        attemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',contractId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        invoiceUrl:recoveryState==='confirmed'?invoiceUrl:null,effectRecorded:true,accessApplied:false,
        reviewRequired:recoveryState==='unknown',actionAdmissionRequired:true,authorization:descriptor.authorization});
      assert.ok(url.endsWith('/recurring-invoice'),'only the explicitly confirmed invoice can mutate');
      if(lostResponse)throw new TypeError('invoice acknowledgement lost after commit');
      return Response.json({status:'confirmed',requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        contractId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',orderId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        billingMode:'recurring',periodSeconds:2592000,invoiceUrl,reviewRequired:false,accessApplied:false,authorization:invoiceAuthorization});
    }});
  await client.authenticate('offline-dom-session');
  const {document,window}=parseHTML(html);window.location={hash:'#subscription'};
  window.HTMLElement.prototype.focus=function(){};
  window.HTMLElement.prototype.reportValidity=function(){return true;};
  app=mountCabinet({document,client,telegram:sdk});t.after(()=>app.destroy());await app.start();
  const flush=async()=>{for(let i=0;i<12;i++)await tick();};
  const buy=async()=>{
    const select=document.querySelector('[data-recurring-plan="dragon"]');assert.equal(select.disabled,false);select.click();await flush();
    const panel=document.querySelector('[data-subscription-confirmation]');assert.ok(panel,document.getElementById('notice').textContent);
    const consent=panel.querySelector('input');consent.checked=true;consent.dispatchEvent(new window.Event('change'));
    panel.querySelector('[data-subscription-confirm]').click();await flush();
  };
  return {f,client,document,app,calls,sdkCalls,values,buy,flush,close:status=>closeInvoice(status),
    refreshDescriptor:async()=>{descriptor=await subscription();},
    posts:()=>calls.filter(row=>row.url.endsWith('/recurring-invoice')),
    notice:()=>document.getElementById('notice'),
    invoice:()=>document.querySelector('[data-subscription-invoice]')};
}

test('invoice modal can remain open without timeout, duplicate open, POST retry or paid authority',async()=>{
  const calls=[];let close;
  const native=createTelegramNativeAdapter({telegram:{version:'6.1',openInvoice(url,cb){calls.push(url);close=cb;}},
    timers:{setTimeout(){throw new Error('payment dialog must not use a timeout');},clearTimeout(){}}});
  const waiting=native.openInvoice(invoiceUrl);
  assert.equal(native.snapshot().busy.invoice,true);
  assert.equal((await native.openInvoice(invoiceUrl)).status,'busy');assert.deepEqual(calls,[invoiceUrl]);
  let finished=false;waiting.then(()=>{finished=true;});await tick();assert.equal(finished,false);
  close('paid');const result=await waiting;assert.deepEqual(result,{status:'paid',reasonCode:'invoice_closed'});
  assert.equal(Object.hasOwn(result,'accessApplied'),false);assert.equal(native.snapshot().busy.invoice,undefined);
  for(const bad of ['https://evil.test/$invoice','https://t.me/$x?token=private','https://u:p@t.me/$x','https://t.me:8443/$x'])
    assert.equal((await native.openInvoice(bad)).status,'unavailable');
  native.destroy();
});

test('session clear settles an open invoice and ignores its late paid callback',async()=>{
  let close;const native=createTelegramNativeAdapter({telegram:{version:'6.1',openInvoice(_url,cb){close=cb;}}});
  const waiting=native.openInvoice(invoiceUrl);native.clearPrivate();assert.equal((await waiting).status,'cleared');
  close('paid');assert.equal((await native.openInvoice(invoiceUrl)).status,'cleared');native.destroy();
});

test('confirmed invoice stays available across refresh and paid SDK callback only refreshes Worker data',async t=>{
  const h=await fixture(t);await h.buy();assert.ok(h.invoice());assert.equal(h.posts().length,1);
  await h.app.navigate('subscription');assert.ok(h.invoice(),'passive refresh preserves the same confirmed invoice');
  const open=h.document.querySelector('[data-native-invoice-open]');open.click();await h.flush();
  assert.deepEqual(h.sdkCalls,[invoiceUrl]);assert.equal(open.disabled,true);assert.notEqual(h.notice().getAttribute('data-status'),'error');
  const before=h.calls.length;open.click();await h.flush();assert.equal(h.calls.length,before);assert.equal(h.sdkCalls.length,1);
  h.close('paid');await h.flush();
  assert.equal(h.posts().length,1);assert.ok(h.calls.slice(before).some(row=>row.init.method==='GET'&&row.url.endsWith('/subscription')));
  assert.ok(h.document.getElementById('screen').textContent.includes('Free'),'a paid SDK hint does not grant access');
  assert.equal(h.f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_ledger').get().n,0);
  assert.ok(h.invoice(),'same invoice remains available until server confirmation');
  await h.f.paid();await h.refreshDescriptor();await h.app.navigate('subscription');
  assert.ok(h.document.querySelector('[data-featured-receipt]'),'only the server confirmed receipt is featured');
  assert.equal(h.invoice(),null);assert.equal(h.posts().length,1);assert.notEqual(h.notice().getAttribute('data-status'),'error');
});

test('lost acknowledgement warning retires only after same saved operation confirms its invoice',async t=>{
  const h=await fixture(t,{lostResponse:true});await h.buy();
  assert.equal(h.posts().length,1);assert.equal(h.client.subscriptionOutcomePending,false);
  const producer=h.posts()[0],lookup=h.calls.find(row=>row.url.endsWith('/operation-status'));
  assert.equal(lookup.init.headers['Idempotency-Key'],producer.init.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(lookup.init.body),{kind:'invoice',intent:JSON.parse(producer.init.body)});
  assert.ok(h.invoice());assert.equal(h.notice().getAttribute('data-status'),'info');
  assert.doesNotMatch(h.notice().textContent,/Ответ не подтверждён/u);assert.equal(h.values.get('re-subscription-pending-v1'),undefined);
});

test('genuine unknown mutation retains red warning, immutable intent and no invoice retry',async t=>{
  const h=await fixture(t,{lostResponse:true,recoveryState:'unknown'});await h.buy();
  assert.equal(h.client.subscriptionOutcomePending,true);assert.equal(h.invoice(),null);
  assert.equal(h.notice().getAttribute('data-status'),'error');assert.match(h.notice().textContent,/Ответ не подтверждён/u);
  const marker=h.values.get('re-subscription-pending-v1');await h.app.navigate('subscription');
  assert.equal(h.client.subscriptionOutcomePending,true);assert.equal(h.values.get('re-subscription-pending-v1'),marker);
  assert.equal(h.posts().length,1);assert.equal(h.notice().getAttribute('data-status'),'error');
  const termsButton=h.document.querySelector('[data-recurring-plan="dragon"]');assert.equal(termsButton.disabled,false);
  termsButton.click();await h.flush();
  const dialog=h.document.querySelector('.subscription-dialog');assert.ok(dialog);
  assert.equal(dialog.querySelector('input'),null);assert.equal(dialog.querySelector('[data-subscription-confirm]'),null);
  assert.equal(h.posts().length,1);assert.equal(h.values.get('re-subscription-pending-v1'),marker);
  assert.equal(h.client.subscriptionOutcomePending,true);assert.equal(h.notice().getAttribute('data-status'),'error');
  assert.match(h.notice().textContent,/Ответ не подтверждён/u);
});
