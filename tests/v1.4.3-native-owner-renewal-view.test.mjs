import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {cabinetSubscriptionFixture} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {readSubscriptionData} from '../src/v1.4.2/subscription-read-model.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {authorizeOwnStarsSubscriptionCommand} from '../src/v1.4.3/subscription-action-authority.mjs';
import {requestOwnStarsSubscriptionCommand} from '../src/v1.4.3/telegram-subscription-provider.mjs';
import {MiniAppClient} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import {mountCabinet} from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';

const requireDom=createRequire(process.env.CABINET_UI_DOM_ROOT
  ?`${process.env.CABINET_UI_DOM_ROOT}/package.json`:new URL('./p08-ui/package.json',import.meta.url));
const {parseHTML}=requireDom('linkedom');
const html=fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const actualNow=Date.now;
const flags=(enabled=true)=>({version:1,mutationsEnabled:false,offerActionsEnabled:false,
  existingRenewalCancellationEnabled:true,...(enabled===null?{}:{nativeOwnerInvoiceOnly:enabled})});
const paidRows=f=>({ledger:f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants:f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all()});

// Genuine local payment and cancellation generate the descriptors. This suite
// checks the browser's scoped transport and presentation; compiled-entry tests
// separately verify native owner HTTP and effect admission.
async function fixture(t,{enabled=true,changeAt=0,change=null,lostResponse=false,unknown=false,hold=false,delayReadAt=0}={}){
  // Multiple fixtures in one test must never restore another fixture's clock.
  Date.now=actualNow;
  const f=cabinetSubscriptionFixture(t);f.now=Math.floor(actualNow()/1000);
  Date.now=()=>f.now*1000;t.after(()=>{Date.now=actualNow;});
  const paid=await f.paid(),target={contractId:paid.contract.contract_id,expectedRevision:paid.contract.revision};
  const canceled=await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.auth({
    payload:{subscriptionAction:'cancel_renewal',...target}})),{telegramApi:async()=>true});
  assert.equal(canceled.status,'confirmed');f.now++;
  let activeWork=0;
  const descriptor=async()=>{
    activeWork++;try {
      const authorization=await f.auth();
      return {...await readSubscriptionData({authorization}),authorization:runtimeAuthorizationDTO(authorization),features:flags()};
    } finally {activeWork--;}
  };
  const initial=await descriptor();assert.equal(initial.renewalActions.enable.available,true);
  const profileAuthorization=runtimeAuthorizationDTO(await f.auth({operation:'profile.read_own'}));
  const bootstrap={readModelVersion:1,authorization:profileAuthorization,features:flags(),systemRole:'user',
    partner:{state:'no_application',application:null,profile:null,legalProfile:null,beta:null,actions:{}},
    navigation:['profile','offers','applications','analytics','subscription'].map(section=>({section,enabled:section!=='analytics',reason:null})),
    counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
  const calls=[],values=new Map(),providerCalls=[];let subscriptionReads=0,app,command=null,releaseResponse=null,releaseRead=null,producerKey=null;
  const client=new MiniAppClient({origin:'https://cabinet.example',now:()=>f.now*1000,
    pendingStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},
    onExpired:()=>app?.expire(),fetchImpl:async(url,init)=>{
      calls.push({url,init});
      if(url.endsWith('/session'))return Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',
        expiresAt:f.now+300,principal:{telegramId:101,botId:123456789},authorizationVersion:1,features:flags(enabled)});
      if(init.method==='GET'){
        if(url.endsWith('/bootstrap'))return Response.json(bootstrap);
        if(url.endsWith('/profile'))return Response.json({readModelVersion:1,authorization:profileAuthorization,features:flags()});
        assert.ok(url.endsWith('/subscription'));
        subscriptionReads++;const current=await descriptor();
        if(change&&subscriptionReads>=changeAt)change(current);
        if(subscriptionReads===delayReadAt)await new Promise(resolve=>{releaseRead=resolve;});
        return Response.json(current);
      }
      if(url.endsWith('/operation-status')){
        assert.equal(init.headers['Idempotency-Key'],producerKey,'recovery uses the original immutable operation key');
        assert.deepEqual(JSON.parse(init.body),{kind:'enable',intent:target});assert.ok(command);
        return Response.json({authority:'worker',kind:'enable',state:command.status,attemptId:command.commandId,
          contractId:target.contractId,invoiceUrl:null,effectRecorded:true,accessApplied:false,
          reviewRequired:command.status==='unknown',actionAdmissionRequired:true,authorization:initial.authorization});
      }
      assert.ok(url.endsWith('/subscription/renewal/enable'),'only the confirmed permission action may mutate');
      const intent=JSON.parse(init.body);assert.deepEqual(intent,target);producerKey=init.headers['Idempotency-Key'];
      activeWork++;try {command=await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.auth({
        payload:{subscriptionAction:'reenable_renewal',...intent},key:producerKey})),{telegramApi:async(_env,method,payload)=>{
        providerCalls.push({method,payload});if(unknown)throw new Error('offline ambiguous provider reply');return true;}});} finally {activeWork--;}
      if(hold)await new Promise(resolve=>{releaseResponse=resolve;});
      if(lostResponse)throw new TypeError('permission acknowledgement lost after actual commit');
      return Response.json({...command,authorization:initial.authorization});
    }});
  await client.authenticate('offline-native-owner-session');
  const {document,window}=parseHTML(html);window.location={hash:'#subscription'};
  window.HTMLElement.prototype.focus=function(){};window.HTMLElement.prototype.reportValidity=function(){return true;};
  app=mountCabinet({document,client});t.after(()=>app.destroy());await app.start();
  const flush=async()=>{
    for(let i=0;i<12;i++)await tick();
    for(let i=0;activeWork>0&&i<2000;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(activeWork,0,'bounded local authorization work settles');
    for(let i=0;i<12;i++)await tick();
  };
  const enable=()=>document.querySelector('[data-renewal-action="enable"]');
  const confirmation=()=>document.querySelector('[data-subscription-confirmation]');
  const posts=()=>calls.filter(call=>call.url.endsWith('/subscription/renewal/enable'));
  const confirm=async()=>{assert.ok(enable());enable().click();await flush();assert.ok(confirmation(),document.getElementById('notice').textContent);
    confirmation().querySelector('[data-subscription-confirm]').click();await flush();};
  return {f,client,document,app,calls,values,target,providerCalls,initial,flush,enable,confirmation,posts,confirm,
    release:()=>releaseResponse(),releaseRead:()=>releaseRead(),beforePaid:paidRows(f),notice:()=>document.getElementById('notice'),
    get subscriptionReads(){return subscriptionReads;}};
}

test('native permission uses two fresh checks and one explicit POST, then directs Telegram re-enable without changing paid access or receipt',async t=>{
  const h=await fixture(t);assert.equal(h.client.canMutate,false);assert.equal(h.subscriptionReads,1);
  h.enable().click();await h.flush();assert.ok(h.confirmation(),h.notice().textContent);assert.equal(h.posts().length,0);
  assert.equal(h.subscriptionReads,2,'opening confirmation checks current contract and revision');
  h.confirmation().querySelector('[data-subscription-confirm]').click();await h.flush();
  assert.equal(h.posts().length,1);const producerIndex=h.calls.findIndex(call=>call.url.endsWith('/renewal/enable'));
  assert.equal(h.calls.slice(0,producerIndex).filter(call=>call.url.endsWith('/subscription')).length,3);
  assert.deepEqual(JSON.parse(h.posts()[0].init.body),h.target);assert.match(h.posts()[0].init.headers['Idempotency-Key'],/^[a-f0-9]{48}$/u);
  assert.equal(h.providerCalls.length,1);assert.equal(h.providerCalls[0].method,'editUserStarSubscription');
  assert.equal(h.providerCalls[0].payload.is_canceled,false);assert.equal(h.client.canMutate,false);
  const fresh=await h.client.read('subscription');assert.equal(fresh.lifecycle.renewalState,'unknown');
  assert.equal(fresh.lifecycle.paidAccess,true);assert.equal(fresh.lifecycle.paidUntil,h.initial.lifecycle.paidUntil);
  assert.deepEqual(fresh.history.items,h.initial.history.items);assert.deepEqual(paidRows(h.f),h.beforePaid);
  assert.ok(h.document.querySelector('[data-native-renewal-permission="pending"]'));
  assert.match(h.notice().textContent,/разделе Stars.*включите продление/u);assert.doesNotMatch(h.notice().textContent,/Автопродление включено/u);
  assert.equal(h.enable(),null);await assert.rejects(h.client.subscriptionAction('enable',h.target),{code:'writes_unavailable'});
  await h.app.navigate('subscription');assert.equal(h.posts().length,1,'refresh never repeats permission');
});

test('duplicate confirmation while awaiting permission acknowledgement sends only one producer',async t=>{
  const h=await fixture(t,{hold:true});h.enable().click();await h.flush();
  const submit=h.confirmation().querySelector('[data-subscription-confirm]');submit.click();await h.flush();
  assert.equal(h.posts().length,1);assert.equal(submit.disabled,true);submit.click();await h.flush();
  await assert.rejects(h.client.subscriptionAction('enable',h.target));assert.equal(h.posts().length,1);
  const marker=h.values.get('re-subscription-pending-v1');assert.ok(marker);h.release();await h.flush();
  assert.equal(h.posts().length,1);assert.equal(h.providerCalls.length,1);assert.deepEqual(paidRows(h.f),h.beforePaid);
});

test('changed contract or revision at either fresh check prevents a permission POST',async t=>{
  for(const [changeAt,change] of [[2,data=>data.renewalActions.expectedRevision++],
    [3,data=>data.renewalActions.expectedRevision++],[3,data=>{
      data.lifecycle.contractId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';data.access.lifecycle=structuredClone(data.lifecycle);
      data.renewalActions.contractId=data.lifecycle.contractId;}],
    [3,data=>{data.renewalActions.enable.available=false;}]]){
    const h=await fixture(t,{changeAt,change});h.enable().click();await h.flush();
    if(changeAt===3){assert.ok(h.confirmation(),h.notice().textContent);h.confirmation().querySelector('[data-subscription-confirm]').click();await h.flush();}
    else assert.equal(h.confirmation(),null);
    assert.equal(h.posts().length,0);assert.equal(h.providerCalls.length,0);assert.deepEqual(paidRows(h.f),h.beforePaid);h.app.destroy();
  }
});

test('lost acknowledgement recovers only the same confirmed permission and clears its stale warning without claiming renewal on',async t=>{
  const h=await fixture(t,{lostResponse:true});await h.confirm();assert.equal(h.posts().length,1);
  assert.equal(h.client.subscriptionOutcomePending,false);assert.equal(h.values.get('re-subscription-pending-v1'),undefined);
  assert.equal(h.calls.filter(row=>row.url.endsWith('/operation-status')).length,1);assert.equal(h.providerCalls.length,1);
  assert.equal(h.notice().getAttribute('data-status'),'info');assert.doesNotMatch(h.notice().textContent,/Ответ не подтверждён/u);
  assert.match(h.notice().textContent,/Статус включения ещё не подтверждён/u);
  assert.ok(h.document.querySelector('[data-native-renewal-permission="pending"]'));
  await h.app.navigate('subscription');assert.equal(h.posts().length,1);assert.deepEqual(paidRows(h.f),h.beforePaid);
});

test('genuine UNKNOWN retains immutable operation and red warning across refresh without a second provider action',async t=>{
  const h=await fixture(t,{lostResponse:true,unknown:true});await h.confirm();assert.equal(h.posts().length,1);
  assert.equal(h.client.subscriptionOutcomePending,true);assert.equal(h.notice().getAttribute('data-status'),'error');
  assert.equal(h.document.querySelector('[data-native-renewal-permission="pending"]'),null,'UNKNOWN does not advertise a granted permission');
  const marker=h.values.get('re-subscription-pending-v1');assert.deepEqual(JSON.parse(marker).intent,h.target);
  await h.app.navigate('subscription');assert.equal(h.values.get('re-subscription-pending-v1'),marker);
  await assert.rejects(h.client.subscriptionAction('enable',h.target));assert.equal(h.posts().length,1);assert.equal(h.providerCalls.length,1);
  assert.equal(h.notice().getAttribute('data-status'),'error');assert.deepEqual(paidRows(h.f),h.beforePaid);
});

test('an older or revoked session and a non-subscription read cannot open native permission transport',async t=>{
  const old=await fixture(t,{enabled:null});old.enable().click();await old.flush();
  old.confirmation().querySelector('[data-subscription-confirm]').click();await old.flush();assert.equal(old.posts().length,0);
  old.app.destroy();
  const h=await fixture(t);const mismatch={...h.target,expectedRevision:h.target.expectedRevision+1};
  await assert.rejects(h.client.subscriptionAction('enable',mismatch),{code:'writes_unavailable'});
  await assert.rejects(h.client.mutate('partner.username',{enabled:true}),{code:'writes_unavailable'});
  await h.client.read('profile');await assert.rejects(h.client.subscriptionAction('enable',h.target),{code:'writes_unavailable'});
  await h.client.read('subscription');h.client.clearSession();await h.flush();assert.equal(h.enable(),null);
  await assert.rejects(h.client.subscriptionAction('enable',h.target),{code:'writes_unavailable'});assert.equal(h.posts().length,0);
});

test('a slower older subscription read cannot reopen permission after a newer read closes it',async t=>{
  const h=await fixture(t,{delayReadAt:2});
  const older=h.client.read('subscription');await h.flush();
  await h.client.read('profile');h.releaseRead();await older;
  await assert.rejects(h.client.subscriptionAction('enable',h.target),{code:'writes_unavailable'});
  assert.equal(h.posts().length,0);assert.equal(h.providerCalls.length,0);assert.deepEqual(paidRows(h.f),h.beforePaid);
});
