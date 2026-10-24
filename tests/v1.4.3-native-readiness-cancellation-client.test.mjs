import test from 'node:test';
import assert from 'node:assert/strict';
import {MiniAppClient} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';

const origin='https://cabinet.example',now=1791060000;
const contractId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const intent={contractId,expectedRevision:1};
const features=(...args)=>{
  const flag=args.length?args[0]:true;
  return {version:1,mutationsEnabled:false,offerActionsEnabled:false,
    ...(flag===undefined?{}:{existingRenewalCancellationEnabled:flag})};
};
const authorization=capability=>({version:1,capability,allowed:true,reasonCode:'allowed',
  policyVersion:'2026-09-18.v1.4.1.foundation',effectivePlan:'free',accessState:'none',
  validUntil:now+240,quota:null,actionPolicy:'allow'});
const session=(flags=features())=>({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',expiresAt:now+300,
  principal:{telegramId:900,botId:123456789},authorizationVersion:1,...(flags===null?{}:{features:flags})});
const read=(flags=features())=>({readModelVersion:1,authorization:authorization('profile.read_own'),
  ...(flags===null?{}:{features:flags})});
const cancellation=()=>({status:'confirmed',commandId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',contractId,
  action:'cancel_renewal',cancellationConfirmed:true,reenableAllowed:false,providerState:null,
  paidPeriodChanged:false,accessApplied:false,reviewRequired:false,authorization:authorization('access.read_own')});
function fixture({auth=session(),response=read(),loseCancellation=false}={}){
  const calls=[],values=new Map(),state={auth,response,loseCancellation,time:now};
  const pendingStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  const client=new MiniAppClient({origin,now:()=>state.time*1000,pendingStorage,
    fetchImpl:async(url,init)=>{calls.push({url,init});
      if(url.endsWith('/session'))return Response.json(state.auth);
      if(init.method==='GET')return Response.json(state.response);
      assert.ok(url.endsWith('/subscription/renewal/cancel'),'only cancellation may cross the read-only client');
      if(state.loseCancellation)throw new TypeError('offline lost cancellation acknowledgement');
      return Response.json(cancellation());}});
  return {client,calls,state,pendingStorage};
}
test('negotiated cancellation sends one own cancel while purchases, re-enable and general writes stay closed',async()=>{
  const f=fixture();await f.client.authenticate('offline-owner-init');
  assert.equal(f.client.canMutate,false);assert.equal(f.client.existingRenewalCancellationEnabled,true);
  await f.client.read('profile');assert.equal(f.client.existingRenewalCancellationEnabled,true);
  for(const kind of ['invoice','enable'])await assert.rejects(f.client.subscriptionAction(kind,intent),{code:'writes_unavailable'});
  await assert.rejects(f.client.mutate('partner.username',{enabled:true}),{code:'writes_unavailable'});
  const result=await f.client.subscriptionAction('cancel',intent);
  assert.equal(result.cancellationConfirmed,true);assert.equal(result.paidPeriodChanged,false);
  assert.equal(f.client.canMutate,false);assert.equal(f.client.subscriptionOutcomePending,false);
  const posts=f.calls.filter(call=>call.url.endsWith('/subscription/renewal/cancel'));
  assert.equal(posts.length,1);assert.deepEqual(JSON.parse(posts[0].init.body),intent);
  assert.equal(posts[0].init.headers.Origin,origin);assert.match(posts[0].init.headers['Idempotency-Key'],/^[a-f0-9]{48}$/u);
});
test('false, omitted and malformed read features only close cancellation and a later read cannot reopen it',async()=>{
  for(const closing of [features(false),features(undefined),null,
    {...features(),existingRenewalCancellationEnabled:'true'}, {...features(),unexpected:true}]){
    const f=fixture();await f.client.authenticate('offline-owner-init');
    f.state.response=read(closing);
    if(closing?.unexpected||closing?.existingRenewalCancellationEnabled==='true')
      await assert.rejects(f.client.read('profile'),{code:'invalid_response'});
    else await f.client.read('profile');
    assert.equal(f.client.existingRenewalCancellationEnabled,false);
    f.state.response=read(features(true));await f.client.read('profile');
    assert.equal(f.client.existingRenewalCancellationEnabled,false,'read cannot renegotiate an unavailable action');
    await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'writes_unavailable'});
    assert.equal(f.calls.filter(call=>call.url.endsWith('/renewal/cancel')).length,0);
  }
});
test('default and older sessions cannot acquire cancellation from a forged read or public property',async()=>{
  for(const flags of [features(undefined),features(false),null]){
    const f=fixture({auth:session(flags)});assert.equal(f.client.existingRenewalCancellationEnabled,false);
    await f.client.authenticate('offline-old-init');await f.client.read('profile');
    assert.equal(f.client.existingRenewalCancellationEnabled,false);
    Object.defineProperty(f.client,'existingRenewalCancellationEnabled',{value:true});
    await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'writes_unavailable'});
    assert.equal(f.client.canMutate,false);assert.equal(f.calls.filter(call=>call.url.endsWith('/renewal/cancel')).length,0);
  }
});
test('authentication validates the whole response before negotiating, and expiry or clearSession revokes availability',async()=>{
  for(const auth of [{...session(),authorizationVersion:2}, {...session(),authorizationVersion:undefined},
    session({...features(),existingRenewalCancellationEnabled:1}),session({...features(),unexpected:true})]){
    const f=fixture({auth});await assert.rejects(f.client.authenticate('offline-malformed-init'),{code:'invalid_response'});
    assert.equal(f.client.existingRenewalCancellationEnabled,false);assert.equal(f.client.authenticated,false);
  }
  const f=fixture();await f.client.authenticate('offline-owner-init');f.client.clearSession();
  assert.equal(f.client.existingRenewalCancellationEnabled,false);
  await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'writes_unavailable'});
  const expired=fixture();await expired.client.authenticate('offline-owner-init');expired.state.time=now+301;
  await assert.rejects(expired.client.subscriptionAction('cancel',intent),{code:'session_expired'});
  assert.equal(expired.client.existingRenewalCancellationEnabled,false);
});
test('lost cancellation acknowledgement retains the immutable intent and never retries through the narrow exception',async()=>{
  const f=fixture({loseCancellation:true});await f.client.authenticate('offline-owner-init');
  await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'subscription_outcome_unknown'});
  const marker=JSON.parse(f.pendingStorage.getItem('re-subscription-pending-v1'));
  assert.equal(marker.kind,'cancel');assert.deepEqual(marker.intent,intent);assert.match(marker.key,/^[a-f0-9]{48}$/u);
  await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'subscription_outcome_unknown'});
  assert.equal(f.calls.filter(call=>call.url.endsWith('/renewal/cancel')).length,1);
  assert.equal(JSON.parse(f.pendingStorage.getItem('re-subscription-pending-v1')).key,marker.key);
  assert.equal(f.client.canMutate,false);
});
