import test from 'node:test';
import assert from 'node:assert/strict';
import {V143_NATIVE_OWNER_CHECKOUT_QUOTES as QUOTES,selectV143NativeOwnerCheckoutQuote as select} from '../src/v1.4.3/native-readiness-config.mjs';
const quote=frame=>({planCode:frame.planCode,currency:frame.currency,amountStars:frame.amountStars,accessSeconds:frame.periodSeconds,
  priceVersion:frame.priceVersion,termsRevision:frame.termsRevision,billingMode:'recurring',publicationState:'approved'});
test('both exact owner monthly canonical quotes use an immutable shared registry',()=>{
  assert.ok(Object.isFrozen(QUOTES));assert.deepEqual(QUOTES.map(f=>[f.planCode,f.amountStars]),[['professional',249],['dragon',499]]);
  for(const frame of QUOTES){assert.ok(Object.isFrozen(frame));assert.equal(select(quote(frame)),frame);assert.equal(frame.ownerId,8987576334);}
});
test('cross-plan amounts, quote versions and every other canonical field must match the selected tariff',()=>{
  for(const frame of QUOTES){
    const q=quote(frame);
    for(const [key,value] of [['amountStars',frame.amountStars===249?499:249],['currency','USD'],['accessSeconds',2591999],
      ['priceVersion',2],['termsRevision','other'],['billingMode','prepaid'],['publicationState','draft'],['planCode','free']])
      assert.equal(select({...q,[key]:value}),null,key+':'+frame.planCode);
    assert.equal(select({...q,planCode:frame.planCode==='dragon'?'professional':'dragon'}),null,'plan substitution retains the wrong amount');
  }
  for(const q of [null,undefined,{}, {planCode:'unknown'}])assert.equal(select(q),null);
});
