import test from 'node:test';
import assert from 'node:assert/strict';
import {createSubscriptionReceiptPresenter} from '../src/v1.4.0-rebuild/mini-app/subscription-view.mjs';
import {subscriptionUIFixture} from './helpers/v1.4.3-subscription-ui-fixture.mjs';

const id=n=>'stars-'+n.toString(16).padStart(24,'0');
const receipt=(n=1,patch={})=>({...subscriptionUIFixture().history.items[0].receipt,receiptId:id(n),...patch});
const history=(items=[])=>({...subscriptionUIFixture(),history:{version:1,authority:'worker',accessAuthority:false,
  available:true,items:items.map(value=>({...value,receipt:value})),limit:20,hasMore:false}});

test('paid invoice callback without a durable own payment stays pending; actual confirmed receipt is the only automatic purchase confirmation',()=>{
  const presenter=createSubscriptionReceiptPresenter(),unpaid=history();
  presenter.observe(unpaid);presenter.beginCheckout('professional',unpaid);
  const callbackOnly={...unpaid,invoice:{status:'paid'},callbackStatus:'paid',lifecycle:{paidAccess:true}};
  assert.deepEqual(presenter.observe(callbackOnly),{receipt:null,pending:true,remainingCount:0});
  const paid=receipt(),confirmed=presenter.observe(history([paid]));
  assert.deepEqual(confirmed,{receipt:paid,pending:false,remainingCount:0});assert.equal(presenter.pending,false);
  const recovered=createSubscriptionReceiptPresenter();recovered.beginCheckout(undefined,unpaid);
  assert.equal(recovered.observe(callbackOnly).pending,true);assert.equal(recovered.observe(history([paid])).receipt.receiptId,paid.receiptId);
});

test('failed, cancelled, retained, unproved and wrong-currency results never fabricate a confirmed purchase receipt',()=>{
  for(const patch of [{status:'failed'},{status:'cancelled'},{status:'retained',reviewRequired:true,paidPeriod:null},
    {status:'paid',reviewRequired:true},{paidPeriod:null},{currency:'USD'},{amountStars:0},{paidPeriod:{startsAt:2,endsAt:1}}]){
    const presenter=createSubscriptionReceiptPresenter(),empty=history();presenter.beginCheckout('dragon',empty);
    const result=presenter.observe(history([receipt(1,patch)]));assert.equal(result.receipt,null,JSON.stringify(patch));assert.equal(result.pending,true);
  }
  const presenter=createSubscriptionReceiptPresenter();assert.equal(presenter.observe({...history([receipt()]),authority:'client'}).receipt,null);
});

test('duplicate and reopen reuse one receipt; a later persisted purchase appears once without replaying historic purchases',()=>{
  const presenter=createSubscriptionReceiptPresenter(),old=receipt(1),latest=receipt(2);
  assert.equal(presenter.observe(history([old])).receipt.receiptId,old.receiptId);
  assert.equal(presenter.observe(history([old])).receipt.receiptId,old.receiptId);
  presenter.dismiss();assert.equal(presenter.observe(history([old])).receipt,null);
  assert.equal(presenter.observe(history([latest,old])).receipt.receiptId,latest.receiptId);
  presenter.dismiss();assert.equal(presenter.observe(history([latest,old])).receipt,null);
  assert.equal(presenter.open(old.receiptId,history([latest,old])),true);
  assert.equal(presenter.observe(history([latest,old])).receipt.receiptId,old.receiptId);
});

test('multiple newly observed purchases are presented individually and the visible queue stays within twenty own operations',()=>{
  const presenter=createSubscriptionReceiptPresenter();presenter.observe(history());
  const purchases=[receipt(2),receipt(1)];let shown=presenter.observe(history(purchases));
  assert.equal(shown.receipt.receiptId,id(2));assert.equal(shown.remainingCount,1);
  presenter.dismiss();shown=presenter.observe(history(purchases));assert.equal(shown.receipt.receiptId,id(1));assert.equal(shown.remainingCount,0);
  presenter.dismiss();assert.equal(presenter.observe(history(purchases)).receipt,null);
  const withLatestRefund=createSubscriptionReceiptPresenter();withLatestRefund.observe(history());
  assert.equal(withLatestRefund.observe(history([receipt(3,{status:'refunded'}),...purchases])).receipt.receiptId,id(2));
  const other=createSubscriptionReceiptPresenter();other.observe(history());
  shown=other.observe(history(Array.from({length:25},(_,index)=>receipt(index+10))));assert.equal(shown.remainingCount,19);
});

test('refresh replaces selected receipt with genuine refund truth; foreign or unavailable history removes the selected payment',()=>{
  const presenter=createSubscriptionReceiptPresenter(),paid=receipt();presenter.observe(history([paid]));
  const refunded=receipt(1,{status:'refunded'});assert.deepEqual(presenter.observe(history([refunded])).receipt,refunded);
  assert.equal(presenter.observe(history()).receipt,null);assert.equal(presenter.open(paid.receiptId,history()),false);
  const stale={...history([paid]),history:{...history([paid]).history,available:false}};
  assert.equal(presenter.observe(stale).receipt,null);
});

test('reopen bookkeeping persists only opaque receipt IDs, never purchase contents; manual own history remains available',()=>{
  const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const paid=receipt(),model=history([paid]),first=createSubscriptionReceiptPresenter({storage});first.observe(model);first.dismiss();
  const persisted=[...values.values()].join('');assert.equal(persisted.includes(paid.receiptId),true);
  for(const value of ['amountStars','paidPeriod','professional','XTR','telegramId'])assert.equal(persisted.includes(value),false);
  const reopened=createSubscriptionReceiptPresenter({storage});assert.equal(reopened.observe(model).receipt,null);
  assert.equal(reopened.open(paid.receiptId,model),true);assert.deepEqual(reopened.observe(model).receipt,paid);
  reopened.clear();assert.equal(reopened.pending,false);assert.equal(reopened.observe(history()).receipt,null);
});
