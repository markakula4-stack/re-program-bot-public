import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {describeTelegramCommandError,telegramCommandDiagnosticStatement} from '../src/v1.4.3/telegram-command-error.mjs';
import {callStarsTelegram} from '../src/v1.3.6/stars-payment-runtime.mjs';

test('private command diagnostic keeps actual HTTP/API disagreement and safely redacts request identities',async()=>{
  const charge='private-charge-123456789',token='123456789:offline_sensitive_bot_token_0123456789';
  const description='Bad Request: subscription cannot be canceled for '+charge+' user 8987576334 '+token+' https://private.example/token';
  const metadata=await describeTelegramCommandError('editUserStarSubscription',{description,error_code:400},502,{redactions:[charge,token,'8987576334']});
  let stored;
  const db={prepare:()=>({bind:(...args)=>{stored=args;return {args};}})};
  telegramCommandDiagnosticStatement(db,{command_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',telegram_id:101},
    {code:'telegram_400',method:'editUserStarSubscription',telegramErrorCode:400,...metadata});
  const detail=JSON.parse(stored[2]);
  assert.equal(detail.httpStatus,502);assert.equal(detail.apiErrorCode,400);
  assert.equal(detail.descriptionSha256,createHash('sha256').update(description).digest('hex'));
  assert.match(detail.descriptionSafe,/subscription cannot be canceled/);
  assert.doesNotMatch(stored[2],/private-charge|8987576334|sensitive_bot_token|private\.example/);
  assert.ok(detail.descriptionSafe.length<=512);
});

test('invalid and oversized descriptions stay absent; bounded descriptions retain a full digest',async()=>{
  assert.equal((await describeTelegramCommandError('editUserStarSubscription',{},403)).telegramApiErrorCode,null);
  await assert.rejects(callStarsTelegram({BOT_TOKEN:'offline'},'editUserStarSubscription',{},
    {fetchImpl:async()=>new Response('invalid JSON',{status:502})}),
    error=>error.ambiguous===true&&error.telegramHttpStatus===502&&error.telegramApiErrorCode===null);
  for(const description of [null,42,'','x'.repeat(4097)]){
    const metadata=await describeTelegramCommandError('editUserStarSubscription',{description},400);
    assert.equal(metadata.telegramDescriptionSafe,null);assert.equal(metadata.telegramDescriptionSha256,null);
  }
  const description='Bad Request: '+('subscription '.repeat(100));
  const metadata=await describeTelegramCommandError('editUserStarSubscription',{description},400);
  assert.equal(metadata.telegramDescriptionTruncated,true);assert.ok(metadata.telegramDescriptionSafe.length<=512);
  assert.equal(metadata.telegramDescriptionSha256,createHash('sha256').update(description).digest('hex'));
});

test('safe categorical Telegram codes retain multiple underscores without exposing numeric IDs or tokens',async()=>{
  const description='Bad Request: SUBSCRIPTION_ALREADY_CANCELED user 8987576334 opaque_private_token_0123456789';
  const metadata=await describeTelegramCommandError('editUserStarSubscription',{description},400);
  let stored;const db={prepare:()=>({bind:(...args)=>{stored=args;return {};}})};
  telegramCommandDiagnosticStatement(db,{command_id:'offline',telegram_id:101},
    {code:'telegram_400',method:'editUserStarSubscription',telegramErrorCode:400,...metadata});
  assert.match(JSON.parse(stored[2]).descriptionSafe,/SUBSCRIPTION_ALREADY_CANCELED/u);
  assert.doesNotMatch(stored[2],/8987576334|opaque_private_token/u);
});
