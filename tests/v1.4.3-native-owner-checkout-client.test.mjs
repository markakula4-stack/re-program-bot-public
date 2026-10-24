import test from 'node:test';
import assert from 'node:assert/strict';
import {MiniAppClient} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';

const now=1791060000,origin='https://cabinet.example';
const intent={planCode:'professional',recurringConsent:true,termsRevision:'2026-10-03.stars-recurring-v1',priceVersion:1};
const auth=capability=>({version:1,capability,allowed:true,reasonCode:'allowed',policyVersion:'2026-09-18.v1.4.1.foundation',effectivePlan:'free',accessState:'none',validUntil:now+240,quota:null,actionPolicy:'allow'});
const features=flag=>({version:1,mutationsEnabled:false,offerActionsEnabled:false,...(flag===undefined?{}:{nativeOwnerInvoiceOnly:flag})});
function fixture(flag,{lose=false}={}) {
  if(arguments.length===0)flag=true;
  const calls=[],values=new Map(),state={flag,time:now,read:features(true),lose,authorizationVersion:1};
  const client=new MiniAppClient({origin,now:()=>state.time*1000,pendingStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},fetchImpl:async(url,init)=>{
    calls.push({url,init});
    if(url.endsWith('/session'))return Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',expiresAt:now+300,
      principal:{telegramId:900,botId:123456789},authorizationVersion:state.authorizationVersion,features:features(state.flag)});
    if(init.method==='GET')return Response.json({readModelVersion:1,authorization:auth('profile.read_own'),...(state.read===null?{}:{features:state.read})});
    assert.ok(url.endsWith('/subscription/recurring-invoice'));
    if(state.lose)throw new TypeError('lost acknowledgement');
    return Response.json({status:'confirmed',requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',contractId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',orderId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',billingMode:'recurring',periodSeconds:2592000,invoiceUrl:'https://t.me/$offline_owner_checkout',reviewRequired:false,accessApplied:false,authorization:auth('billing.purchase_monthly')});
  }});
  return {client,calls,state,values};
}
const closed=f=>assert.rejects(f.client.subscriptionAction('invoice',intent),{code:'writes_unavailable'});
test('auth negotiates both owner monthly plans with general writes closed',async()=>{
  const f=fixture();await f.client.authenticate('offline-owner-init');await f.client.read('profile');
  for(const bad of [{...intent,planCode:'free'},{...intent,planCode:'unknown'},{...intent,priceVersion:2}])await assert.rejects(f.client.subscriptionAction('invoice',bad),{code:'writes_unavailable'});
  for(const kind of ['cancel','enable'])await assert.rejects(f.client.subscriptionAction(kind,{contractId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedRevision:1}),{code:'writes_unavailable'});
  await assert.rejects(f.client.mutate('partner.username',{enabled:true}),{code:'writes_unavailable'});
  const result=await f.client.subscriptionAction('invoice',intent);assert.equal(result.accessApplied,false);assert.equal(f.client.canMutate,false);
  const posts=f.calls.filter(c=>c.url.endsWith('/recurring-invoice'));assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].init.body),intent);assert.match(posts[0].init.headers['Idempotency-Key'],/^[a-f0-9]{48}$/u);
  const dragon=fixture();await dragon.client.authenticate('offline-owner-init');await dragon.client.read('profile');
  const dragonIntent={...intent,planCode:'dragon'};assert.equal((await dragon.client.subscriptionAction('invoice',dragonIntent)).accessApplied,false);
  assert.equal(dragon.client.canMutate,false);assert.deepEqual(JSON.parse(dragon.calls.find(c=>c.url.endsWith('/recurring-invoice')).init.body),dragonIntent);
});
test('reads cannot negotiate or reopen invoice availability, including malformed or omitted flags',async()=>{
  for(const flag of [false,undefined]) {
    const f=fixture(flag);await f.client.authenticate('offline-owner-init');f.client.nativeOwnerInvoiceOnly=true;await f.client.read('profile');await closed(f);
  }
  for(const closing of [features(false),features(undefined),null,{...features(true),nativeOwnerInvoiceOnly:'true'},{...features(true),unexpected:true}]){
    const f=fixture();await f.client.authenticate('offline-owner-init');f.state.read=closing;
    if(closing?.unexpected||closing?.nativeOwnerInvoiceOnly==='true')await assert.rejects(f.client.read('profile'),{code:'invalid_response'});else await f.client.read('profile');
    f.state.read=features(true);await f.client.read('profile');await closed(f);
    assert.equal(f.calls.filter(c=>c.url.endsWith('/recurring-invoice')).length,0);
  }
});
test('clear and expiry close invoice exception and lost response retains immutable intent without retry',async()=>{
  const cleared=fixture();await cleared.client.authenticate('offline-owner-init');cleared.client.clearSession();await closed(cleared);
  const expired=fixture();await expired.client.authenticate('offline-owner-init');expired.state.time=now+301;
  await assert.rejects(expired.client.subscriptionAction('invoice',intent),{code:'session_expired'});await closed(expired);
  const f=fixture(true,{lose:true});await f.client.authenticate('offline-owner-init');
  await assert.rejects(f.client.subscriptionAction('invoice',intent),{code:'subscription_outcome_unknown'});
  const marker=JSON.parse(f.values.get('re-subscription-pending-v1'));assert.deepEqual(marker.intent,intent);
  await assert.rejects(f.client.subscriptionAction('invoice',intent),{code:'subscription_outcome_unknown'});
  assert.equal(f.calls.filter(c=>c.url.endsWith('/recurring-invoice')).length,1);
  assert.equal(JSON.parse(f.values.get('re-subscription-pending-v1')).key,marker.key);
  const dragon=fixture(true,{lose:true});await dragon.client.authenticate('offline-owner-init');
  await assert.rejects(dragon.client.subscriptionAction('invoice',{...intent,planCode:'dragon'}),{code:'subscription_outcome_unknown'});
  const dragonMarker=JSON.parse(dragon.values.get('re-subscription-pending-v1'));
  await assert.rejects(dragon.client.subscriptionAction('invoice',intent),{code:'subscription_outcome_unknown'});
  assert.equal(dragon.calls.filter(c=>c.url.endsWith('/recurring-invoice')).length,1);
  assert.deepEqual(JSON.parse(dragon.values.get('re-subscription-pending-v1')),dragonMarker);
});

test('invoice exception requires valid authorization version before storing the session',async()=>{
  const f=fixture();f.state.authorizationVersion=undefined;
  await assert.rejects(f.client.authenticate('offline-owner-init'),{code:'invalid_response'});
  await closed(f);assert.equal(f.calls.filter(c=>c.url.endsWith('/recurring-invoice')).length,0);
});
