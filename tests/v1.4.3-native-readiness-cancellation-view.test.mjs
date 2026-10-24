import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {cabinetSubscriptionFixture} from './helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {readSubscriptionData} from '../src/v1.4.2/subscription-read-model.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {MiniAppClient} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import {mountCabinet} from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';

const requireDom=createRequire(process.env.CABINET_UI_DOM_ROOT
  ?`${process.env.CABINET_UI_DOM_ROOT}/package.json`:new URL('./p08-ui/package.json',import.meta.url));
const {parseHTML}=requireDom('linkedom');
const html=fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const actualNow=Date.now;
const flags=(enabled=true)=>({version:1,mutationsEnabled:false,offerActionsEnabled:false,
  ...(enabled===null?{}:{existingRenewalCancellationEnabled:enabled})});
const money=f=>({ledger:f.sqlite.prepare('SELECT * FROM payment_ledger ORDER BY ledger_entry_id').all(),
  grants:f.sqlite.prepare('SELECT * FROM subscription_access_grants ORDER BY grant_id').all(),
  commands:f.sqlite.prepare('SELECT * FROM subscription_provider_commands ORDER BY command_id').all()});

// The baseline descriptor comes from genuine private server authorization and
// verified synthetic paid records. DOM transport responses model presentation
// races only; the separate native full-entry suite proves HTTP admission.
async function fixture(t,{enabled=true,changeAt=0,change=null}={}){
  Date.now=actualNow;
  const f=cabinetSubscriptionFixture(t);f.now=Math.floor(actualNow()/1000);
  Date.now=()=>f.now*1000;t.after(()=>{Date.now=actualNow;});
  await f.paid();
  f.serverEnv={...f.serverEnv,STARS_RECURRING_ENABLED:'false'};
  const authorization=await f.auth(),data=await readSubscriptionData({authorization});
  const descriptor={...data,authorization:runtimeAuthorizationDTO(authorization),features:flags()};
  assert.equal(descriptor.renewalActions.cancel.available,true);
  assert.equal(descriptor.renewalActions.enable.available,false);
  assert.equal(descriptor.catalog.recurring.ready,false);
  const profileAuthorization=runtimeAuthorizationDTO(await f.auth({operation:'profile.read_own'}));
  const bootstrap={readModelVersion:1,authorization:profileAuthorization,features:flags(),systemRole:'user',
    partner:{state:'no_application',application:null,profile:null,legalProfile:null,beta:null,actions:{}},
    navigation:['profile','offers','applications','analytics','subscription'].map(section=>({section,enabled:section!=='analytics',reason:null})),
    counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
  const calls=[],values=new Map();let subscriptionReads=0,app;
  const client=new MiniAppClient({origin:'https://cabinet.example',now:()=>f.now*1000,
    pendingStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},
    onExpired:()=>app?.expire(),fetchImpl:async(url,init)=>{
      calls.push({url,init});
      if(url.endsWith('/session'))return Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',
        expiresAt:f.now+300,principal:{telegramId:101,botId:123456789},authorizationVersion:1,features:flags(enabled)});
      if(init.method==='GET'){
        if(url.endsWith('/bootstrap'))return Response.json(bootstrap);
        assert.ok(url.endsWith('/subscription'),'only the own subscription is read');
        subscriptionReads++;
        const current=structuredClone(descriptor);
        if(change&&subscriptionReads>=changeAt)change(current);
        return Response.json(current);
      }
      assert.ok(url.endsWith('/subscription/renewal/cancel'),'DOM cannot send another financial action');
      const intent=JSON.parse(init.body);
      return Response.json({status:'confirmed',contractId:intent.contractId,action:'cancel_renewal',
        cancellationConfirmed:true,reenableAllowed:false,providerState:null,paidPeriodChanged:false,
        accessApplied:false,authorization:descriptor.authorization});
    }});
  await client.authenticate('offline-dom-session');
  const {document,window}=parseHTML(html);window.location={hash:'#subscription'};
  window.HTMLElement.prototype.focus=function(){};
  window.HTMLElement.prototype.reportValidity=function(){return true;};
  app=mountCabinet({document,client});t.after(()=>app.destroy());await app.start();
  const posts=()=>calls.filter(call=>call.init.method==='POST'&&!call.url.endsWith('/session'));
  const cancel=()=>document.querySelector('[data-renewal-action="cancel"]');
  const confirmation=()=>document.querySelector('[data-subscription-confirmation]');
  const flush=async()=>{for(let i=0;i<12;i++)await tick();};
  return {f,client,document,descriptor,calls,posts,cancel,confirmation,flush,
    get subscriptionReads(){return subscriptionReads;},beforeMoney:money(f)};
}

test('read-only cabinet renders server cancellation and uses two fresh checks before one explicit cancel',async t=>{
  const h=await fixture(t);assert.equal(h.client.canMutate,false);
  assert.equal(h.client.existingRenewalCancellationEnabled,true);
  assert.ok(h.cancel());assert.equal(h.cancel().disabled,false);assert.equal(h.subscriptionReads,1);
  h.cancel().click();await h.flush();assert.ok(h.confirmation());assert.equal(h.subscriptionReads,2);
  assert.equal(h.posts().length,0,'opening confirmation is read-only');
  h.confirmation().querySelector('[data-subscription-confirm]').click();await h.flush();
  assert.equal(h.posts().length,1);assert.ok(h.subscriptionReads>=4,'second fresh check precedes the response refresh');
  const postIndex=h.calls.findIndex(call=>call.url.endsWith('/renewal/cancel'));
  assert.equal(h.calls.slice(0,postIndex).filter(call=>call.url.endsWith('/subscription')).length,3);
  assert.deepEqual(JSON.parse(h.posts()[0].init.body),{contractId:h.descriptor.renewalActions.contractId,
    expectedRevision:h.descriptor.renewalActions.expectedRevision});
  assert.equal(h.posts()[0].init.headers.Origin,'https://cabinet.example');
  assert.match(h.posts()[0].init.headers['Idempotency-Key'],/^[a-f0-9]{48}$/u);
  assert.equal(h.client.canMutate,false);assert.deepEqual(money(h.f),h.beforeMoney);
});

test('changed revision on the first fresh check does not open confirmation or send cancellation',async t=>{
  const h=await fixture(t,{changeAt:2,change:data=>data.renewalActions.expectedRevision++});
  h.cancel().click();await h.flush();assert.equal(h.confirmation(),null);assert.equal(h.posts().length,0);
  assert.deepEqual(money(h.f),h.beforeMoney);
});

test('changed revision after confirmation prevents the cancellation POST',async t=>{
  const h=await fixture(t,{changeAt:3,change:data=>data.renewalActions.expectedRevision++});
  h.cancel().click();await h.flush();assert.ok(h.confirmation());
  h.confirmation().querySelector('[data-subscription-confirm]').click();await h.flush();
  assert.equal(h.posts().length,0);assert.deepEqual(money(h.f),h.beforeMoney);
});

test('an unknown pending renewal observed at final confirmation prevents cancellation',async t=>{
  const h=await fixture(t,{changeAt:3,change:data=>{
    data.lifecycle.pendingOperations=1;data.lifecycle.reviewRequired=true;data.lifecycle.renewalState='unknown';
    data.lifecycle.reviewReasons=['provider_command_unknown'];data.access.lifecycle=structuredClone(data.lifecycle);
    data.renewalActions.pendingOperations=1;data.renewalActions.renewalState='unknown';
  }});
  h.cancel().click();await h.flush();assert.ok(h.confirmation());
  h.confirmation().querySelector('[data-subscription-confirm]').click();await h.flush();
  assert.equal(h.posts().length,0);assert.equal(h.cancel().disabled,true);assert.deepEqual(money(h.f),h.beforeMoney);
});

test('cancellation availability opens neither invoice, re-enable, refund nor general mutation controls',async t=>{
  const h=await fixture(t);assert.equal(h.document.querySelector('[data-renewal-action="enable"]'),null);
  assert.ok([...h.document.querySelectorAll('[data-recurring-plan]')].every(node=>node.disabled));
  for(const kind of ['invoice','enable','refund'])await assert.rejects(h.client.subscriptionAction(kind,{}),{code:'writes_unavailable'});
  await assert.rejects(h.client.mutate('offer.create',{}),{code:'writes_unavailable'});
  assert.equal(h.posts().length,0);assert.deepEqual(money(h.f),h.beforeMoney);
});

test('an older session cannot gain cancellation from a read or confirmation',async t=>{
  const old=await fixture(t,{enabled:null});assert.equal(old.client.existingRenewalCancellationEnabled,false);
  old.cancel().click();await old.flush();assert.ok(old.confirmation());
  old.confirmation().querySelector('[data-subscription-confirm]').click();await old.flush();
  assert.equal(old.posts().length,0);assert.equal(old.client.existingRenewalCancellationEnabled,false);
});

test('clearing the session removes cancellation availability and the GUI path',async t=>{
  const cleared=await fixture(t);cleared.client.clearSession();await cleared.flush();
  assert.equal(cleared.client.existingRenewalCancellationEnabled,false);assert.equal(cleared.cancel(),null);
  await assert.rejects(cleared.client.subscriptionAction('cancel',{}),{code:'writes_unavailable'});
  assert.equal(cleared.posts().length,0);
});
