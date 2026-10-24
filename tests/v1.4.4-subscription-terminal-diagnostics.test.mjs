import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MiniAppClient } from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import { callStarsTelegram } from '../src/v1.3.6/stars-payment-runtime.mjs';
import { describeTelegramCommandError, telegramCommandReason } from '../src/v1.4.3/telegram-command-error.mjs';

const origin='https://cabinet.example',now=1791403927,contractId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const intent={contractId,expectedRevision:2},storageKey='re-subscription-pending-v1';
const authorization={version:1,capability:'access.read_own',allowed:true,reasonCode:'allowed',policyVersion:'2026-09-18.v1.4.1.foundation',effectivePlan:'free',accessState:'none',validUntil:now+240,quota:null,actionPolicy:'allow'};
const marker=()=>({kind:'cancel',key:'a'.repeat(48),startedAt:now-3,intent});
const terminal=(status='rejected')=>({status,commandId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',contractId,action:'cancel_renewal',cancellationConfirmed:status==='confirmed',reenableAllowed:false,providerState:null,paidPeriodChanged:false,accessApplied:false,reviewRequired:status==='unknown',authorization});
const recovered=(state='rejected')=>({authority:'worker',kind:'cancel',state,attemptId:state==='missing'?null:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',contractId:state==='missing'?null:contractId,invoiceUrl:null,effectRecorded:state!=='missing',accessApplied:false,reviewRequired:['unknown','pending'].includes(state),actionAdmissionRequired:true,authorization});
function fixture({saved=null,result=terminal(),recovery=recovered(),removeFails=true,principal={telegramId:900,botId:123456789}}={}) {
 const values=new Map(saved?[[storageKey,JSON.stringify(saved)]]:[]),calls=[];
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>{if(removeFails)throw Error('browser storage cleanup unavailable');values.delete(key);}};
 const makeClient=()=>new MiniAppClient({origin,now:()=>now*1000,pendingStorage:storage,fetchImpl:async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/session'))return Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',expiresAt:now+300,authorizationVersion:1,...(principal?{principal}:{}),features:{version:1,mutationsEnabled:false,offerActionsEnabled:false,existingRenewalCancellationEnabled:true}});
  if(url.endsWith('/subscription/renewal/cancel'))return Response.json(result);
  if(url.endsWith('/subscription/operation-status'))return Response.json(recovery);
  throw Error('unexpected outbound operation');
 }});
 return {client:makeClient(),makeClient,values,calls};
}

test('missing session principal blocks cancellation before any financial request',async()=>{
 const f=fixture({principal:null});await f.client.authenticate('offline-init');
 await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'writes_unavailable'});
 assert.equal(f.calls.filter(c=>c.url.endsWith('/renewal/cancel')).length,0);
 assert.equal(f.values.has(storageKey),false);
});
test('validated terminal cancel responses stay terminal when browser cleanup fails; original durable key remains recoverable',async()=>{
 for(const state of ['rejected','confirmed']){
  const f=fixture({result:terminal(state)});await f.client.authenticate('offline-init');
  const result=await f.client.subscriptionAction('cancel',intent);
  assert.equal(result.status,state);assert.equal(f.client.subscriptionOutcomePending,false);assert.equal(f.client.subscriptionStorageNeedsRecovery,true);
  const saved=JSON.parse(f.values.get(storageKey));assert.deepEqual(saved.intent,intent);assert.equal(saved.kind,'cancel');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/renewal/cancel')).length,1);assert.equal(result.accessApplied,false);assert.equal(f.client.canMutate,false);
 }
});
test('read-only recovery clears verified terminal memory despite persistent cleanup failure and retains the exact intent on reload',async()=>{
 for(const state of ['rejected','confirmed']){
  const saved=marker(),f=fixture({saved,recovery:recovered(state)});await f.client.authenticate('offline-init');
  assert.equal((await f.client.recoverSubscriptionAction()).state,state);assert.equal(f.client.subscriptionOutcomePending,false);assert.equal(f.client.subscriptionStorageNeedsRecovery,true);
  assert.deepEqual(JSON.parse(f.values.get(storageKey)),saved);
  const reloaded=f.makeClient();await reloaded.authenticate('offline-reload');assert.equal(reloaded.subscriptionOutcomePending,true);
  await reloaded.recoverSubscriptionAction();assert.equal(reloaded.subscriptionOutcomePending,false);
  const reads=f.calls.filter(c=>c.url.endsWith('/operation-status'));assert.equal(reads.length,2);
  for(const call of reads){assert.equal(call.init.headers['Idempotency-Key'],saved.key);assert.deepEqual(JSON.parse(call.init.body),{kind:'cancel',intent});}
  assert.equal(f.calls.filter(c=>c.url.endsWith('/renewal/cancel')).length,0);
 }
});
test('missing, pending, unknown and malformed recovery responses retain the original uncertain guard without a cancel replay',async()=>{
 for(const state of ['missing','pending','unknown','malformed']){
  const saved=marker(),body=state==='malformed'?{...recovered(),contractId:'different'}:recovered(state),f=fixture({saved,recovery:body});
  await f.client.authenticate('offline-init');
  if(state==='malformed')await assert.rejects(f.client.recoverSubscriptionAction(),{code:'invalid_response'});else await f.client.recoverSubscriptionAction();
  assert.equal(f.client.subscriptionOutcomePending,true);assert.equal(f.client.subscriptionStorageNeedsRecovery,false);assert.deepEqual(JSON.parse(f.values.get(storageKey)),saved);
  assert.equal(f.calls.filter(c=>c.url.endsWith('/renewal/cancel')).length,0);
 }
});
test('successful durable cleanup clears the local recovery flag',async()=>{
 const f=fixture({saved:marker(),removeFails:false});await f.client.authenticate('offline-init');await f.client.recoverSubscriptionAction();
 assert.equal(f.client.subscriptionOutcomePending,false);assert.equal(f.client.subscriptionStorageNeedsRecovery,false);assert.equal(f.values.has(storageKey),false);
});
test('a terminal-looking direct response must pass the original authorization and effect checks before memory is cleared',async()=>{
 for(const result of [{...terminal(),cancellationConfirmed:true},{...terminal(),accessApplied:true},{...terminal(),authorization:{...authorization,allowed:false}}]){
  const f=fixture({result});await f.client.authenticate('offline-init');
  await assert.rejects(f.client.subscriptionAction('cancel',intent),{code:'subscription_outcome_unknown'});
  assert.equal(f.client.subscriptionOutcomePending,true);assert.equal(f.client.subscriptionStorageNeedsRecovery,false);assert.ok(f.values.has(storageKey));
  assert.equal(f.calls.filter(c=>c.url.endsWith('/renewal/cancel')).length,1);
 }
});
test('actual mocked Telegram parser retains finite charge/user diagnostics without changing numeric rejection or inventing cancellation',async()=>{
 for(const code of ['CHARGE_ID_INVALID','USER_ID_INVALID']){
  let requests=0,error;
  try {await callStarsTelegram({BOT_TOKEN:'offline-token'},'editUserStarSubscription',{user_id:101,telegram_payment_charge_id:'offline-charge',is_canceled:true},{fetchImpl:async()=>{requests++;return Response.json({ok:false,error_code:400,description:'Bad Request: '+code},{status:400});}});}catch(e){error=e;}
  assert.equal(requests,1);assert.equal(error.code,'telegram_400');assert.equal(error.telegramErrorCode,400);assert.equal(error.telegramHttpStatus,400);assert.equal(error.ambiguous,false);
  assert.equal(telegramCommandReason(error),'telegram_400_'+code.toLowerCase());assert.equal(error.telegramDescriptionRecorded,false);assert.equal(Object.hasOwn(error,'description'),false);
  assert.equal(telegramCommandReason(error).length<=64,true);
 }
});
test('unknown or sensitive provider prose is fingerprinted only; mismatching actual HTTP status remains distinct',async()=>{
 const description='Bad Request: private-charge-123456789 https://private.example/token';
 const metadata=await describeTelegramCommandError('editUserStarSubscription',{description},502);
 assert.equal(metadata.telegramHttpStatus,502);assert.equal(metadata.telegramDescriptionCode,'unclassified');assert.equal(metadata.telegramDescriptionSha256,createHash('sha256').update(description).digest('hex'));
 const reason=telegramCommandReason({code:'telegram_400',method:'editUserStarSubscription',...metadata});
 assert.match(reason,/^telegram_400_detail_[a-f0-9]{16}$/u);assert.doesNotMatch(JSON.stringify(metadata)+reason,/private-charge|private\.example|123456789/);
 assert.equal(await describeTelegramCommandError('refundStarPayment',{description},400),null);
});
test('absent, overlong and newline-extended descriptions cannot become classified causes or force a provider success',async()=>{
 for(const description of [null,42,'','x'.repeat(4097),'Bad Request: CHARGE_ID_INVALID\n']){
  const metadata=await describeTelegramCommandError('editUserStarSubscription',{description},0);assert.equal(metadata.telegramDescriptionCode,'unclassified');assert.equal(metadata.telegramHttpStatus,null);
  const reason=telegramCommandReason({code:'telegram_400',method:'editUserStarSubscription',...metadata});assert.equal(reason.length<=64,true);assert.doesNotMatch(reason,/charge_id_invalid/);
 }
 assert.equal(telegramCommandReason({code:'telegram_transport_timeout',method:'editUserStarSubscription'}),'telegram_transport_timeout');
});

test('Unicode lookalikes cannot enter the finite ASCII Telegram diagnostic enum',async()=>{
 for(const description of ['UſER_ID_INVALID','Bad Requeſt: CHARGE_ID_INVALID']){
  const d=await describeTelegramCommandError('editUserStarSubscription',{description},400);
  assert.equal(d.telegramDescriptionCode,'unclassified');
  assert.match(telegramCommandReason({method:'editUserStarSubscription',code:'telegram_400',...d}),/^telegram_400_detail_[a-f0-9]{16}$/u);
 }
 const d=await describeTelegramCommandError('editUserStarSubscription',{description:'bad request: charge_id_invalid'},400);
 assert.equal(d.telegramDescriptionCode,'charge_id_invalid');
});
