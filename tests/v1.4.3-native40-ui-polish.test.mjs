import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSubscriptionScreen} from '../src/v1.4.0-rebuild/mini-app/subscription-view.mjs';
import {createOfflineSubscriptionVisual} from '../scripts/v1.4.3-native40-ui-preview.mjs';

const financialPosts=h=>h.calls.filter(call=>call.init.method==='POST'&&!call.url.endsWith('/session'));
const shownCard=h=>h.document.querySelector('.subscription-current');

test('paid card keeps verified plan, paid-until, renewal status and visible source details',async t=>{
  const h=await createOfflineSubscriptionVisual({after:callback=>t.after(callback)}),card=shownCard(h);
  assert.equal(card.getAttribute('data-current-plan'),'professional');assert.equal(card.querySelector('h3').textContent,'Professional');
  assert.equal(card.querySelector('.badge').textContent,'Активна');
  assert.match(card.querySelector('.subscription-paid-until').textContent,/Оплачено до.*МСК/u);
  assert.match(card.querySelector('.subscription-current-time').textContent,/Осталось/u);
  assert.match(card.querySelector('.subscription-facts').textContent,/ПродлениеСтатус не подтверждён/u);
  assert.equal(card.querySelector('.subscription-current-details').tagName,'DIV');
  assert.equal(card.querySelector('.subscription-current-details').closest('details'),null);
  assert.match(card.querySelector('.subscription-current-details').textContent,/ИсточникОплата Telegram Stars/u);
  assert.equal(card.querySelectorAll(':scope > .subscription-muted').length,0,'routine remaining-duration and source paragraphs do not compete with paid-until');
  assert.deepEqual(financialPosts(h),[]);
});

test('canceled paid subscription presents one permission action and preserves active paid access',async t=>{
  const h=await createOfflineSubscriptionVisual({state:'canceled',after:callback=>t.after(callback)}),card=shownCard(h);
  assert.equal(h.initial.lifecycle.paidAccess,true);assert.equal(h.initial.lifecycle.renewalState,'canceled');
  assert.equal(card.querySelector('.badge').textContent,'Активна','the paid access state is distinct from canceled renewal');
  assert.match(card.textContent,/ПродлениеОтменено/u);
  assert.equal(card.querySelector('[data-renewal-action="cancel"]'),null);
  assert.equal(card.querySelector('[data-renewal-action="enable"]').textContent,'Разрешить включение');
  assert.match(card.textContent,/Оплаченный срок сохраняется/u);assert.deepEqual(financialPosts(h),[]);
});

test('permission acknowledgement stays unknown and offers status check without a redundant provider command',async t=>{
  const h=await createOfflineSubscriptionVisual({state:'permission',after:callback=>t.after(callback)}),card=shownCard(h);
  assert.equal(h.initial.lifecycle.renewalState,'unknown');assert.equal(h.initial.lifecycle.paidAccess,true);
  assert.match(card.querySelector('[data-native-renewal-permission="pending"]').textContent,/Разрешение получено.*Telegram.*Мои подписки.*Проверить статус/u);
  assert.match(card.querySelector('.subscription-current-details').textContent,/Разрешение не включает автопродление за вас/u);
  assert.equal(h.initial.renewalActions.cancel.available,true);assert.equal(h.initial.renewalActions.enable.available,false);
  // Compare primitive attributes, never a failed assertion's entire linked DOM.
  assert.deepEqual([...card.querySelectorAll('[data-renewal-action]')].map(node=>node.getAttribute('data-renewal-action')),['cancel']);
  const cancel=card.querySelector('[data-renewal-action="cancel"]');assert.equal(cancel.disabled,false);
  assert.doesNotMatch(card.textContent,/Автопродление включено/u);
  assert.deepEqual(financialPosts(h),[]);assert.equal(h.providerCalls.length,2,'only the synthetic fixture cancel and permission produced local ACKs');
  const readsBefore=h.calls.filter(call=>call.url.endsWith('/subscription')).length;
  cancel.click();await h.flush();
  const panel=h.document.querySelector('[data-subscription-confirmation]');assert.ok(Boolean(panel),'explicit cancellation opens its confirmation');
  assert.equal(h.calls.filter(call=>call.url.endsWith('/subscription')).length,readsBefore+1,'opening confirmation checks fresh server authority');
  assert.equal(panel.querySelector('[data-subscription-confirm]').disabled,false);
  assert.deepEqual(financialPosts(h),[],'opening confirmation never sends a provider command');
  [...panel.querySelectorAll('button')].find(node=>node.textContent==='Назад').click();await h.flush();
  assert.equal(h.document.querySelectorAll('[data-subscription-confirmation]').length,0);
  assert.deepEqual(financialPosts(h),[]);assert.equal(h.providerCalls.length,2);
});

test('confirmation is an accessible dialog focused immediately and back or Escape sends no financial action',async t=>{
  for(const state of ['cancel-confirmation','enable-confirmation']) {
    const h=await createOfflineSubscriptionVisual({state,after:callback=>t.after(callback)});
    const dialog=h.document.querySelector('dialog.subscription-dialog'),panel=dialog.querySelector('[data-subscription-confirmation]');
    assert.equal(dialog.getAttribute('aria-modal'),'true');assert.equal(dialog.getAttribute('aria-labelledby'),panel.querySelector('h3').id);
    assert.equal(h.document._visualFocused,panel);assert.equal(dialog.parentElement.getAttribute('data-subscription-screen'),'true');
    assert.equal(panel.querySelector('input'),null,'existing-contract management is not a fresh purchase');
    assert.deepEqual(financialPosts(h),[]);
    if(state==='cancel-confirmation') [...panel.querySelectorAll('button')].find(node=>node.textContent==='Назад').click();
    else {const event=new h.window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:'Escape'});dialog.dispatchEvent(event);}
    assert.equal(h.document.querySelector('.subscription-dialog'),null);assert.deepEqual(financialPosts(h),[]);
  }
});

test('monthly checkout keeps exact price and explicit unchecked consent before a linked full terms disclosure',async t=>{
  const h=await createOfflineSubscriptionVisual({state:'purchase',after:callback=>t.after(callback)}),panel=h.document.querySelector('[data-subscription-confirmation]');
  assert.match(panel.textContent,/249 Stars каждые 30 дней/u);
  const terms=panel.querySelector('details.subscription-terms');assert.equal(terms.hasAttribute('open'),false);
  assert.equal(terms.querySelector('.subscription-terms-text').textContent,h.initial.catalog.recurring.terms.text);
  const checkbox=panel.querySelector('input[type="checkbox"]'),submit=panel.querySelector('[data-subscription-confirm]');
  assert.equal(checkbox.checked,false);assert.equal(submit.disabled,true);submit.click();await h.flush();assert.deepEqual(financialPosts(h),[]);
  checkbox.checked=true;checkbox.dispatchEvent(new h.window.Event('change'));assert.equal(submit.disabled,false);
  assert.match(panel.querySelector('.subscription-consent').textContent,/249 Stars каждые 30 дней.*принимаю условия.*Продление можно отменить/u);
});

test('purchase choices, history, limits, Preview and Telegram features are visible; only terms are disclosed',async t=>{
  const h=await createOfflineSubscriptionVisual({after:callback=>t.after(callback)}),page=h.document.querySelector('[data-subscription-screen]');
  for(const selector of ['.subscription-capacity-details','.subscription-catalog-details','.subscription-preview-details','.subscription-history','.subscription-telegram-details']) {
    const section=page.querySelector(selector);assert.ok(section,`${selector} remains present`);
    assert.notEqual(section.tagName,'DETAILS');assert.equal(section.closest('details'),null,`${selector} is not hidden inside a disclosure`);
  }
  const terms=page.querySelector('.subscription-payment-help .subscription-terms');
  assert.equal(terms.querySelector('.subscription-terms-text').textContent,h.initial.catalog.terms.text);
  assert.equal(terms.querySelector('summary').textContent,'Условия и возврат');
  assert.ok(page.querySelector('[data-recurring-plan="professional"]'));
  assert.ok(page.querySelector('[data-recurring-plan="dragon"]'));
  for(const [plan,amount] of [['free',0],['professional',249],['dragon',499]]) {
    const planCard=page.querySelector(`[data-plan="${plan}"]`);
    assert.equal(planCard.closest('details'),null);assert.match(planCard.querySelector('.subscription-price').textContent,new RegExp(`${amount} Stars`));
    assert.equal(planCard.getAttribute('data-billing-mode'),plan==='free'?'free':'prepaid');
    if(plan!=='free') {
      assert.match(planCard.textContent,/предоплата.*Продление вручную/u);
      assert.ok(planCard.querySelector(`[data-purchase-plan="${plan}"]`),'prepaid purchase button stays visible');
      const monthly=page.querySelector(`[data-recurring-plan="${plan}"]`).closest('.subscription-monthly-offer');
      assert.equal(monthly.closest('details'),null);assert.equal(monthly.getAttribute('data-billing-mode'),'recurring');
      assert.match(monthly.textContent,new RegExp(`${amount} Stars каждые 30 дней`));
    }
  }
  const sections=[...page.children],currentIndex=sections.indexOf(page.querySelector('.subscription-current'));
  assert.equal(sections[currentIndex+1],page.querySelector('.subscription-plans'),'purchase choices immediately follow the current tariff');
  assert.equal(sections[currentIndex+2],page.querySelector('.subscription-monthly'),'monthly options are a separate visible section');
  assert.deepEqual(financialPosts(h),[]);
});

test('all receipts moves accessible focus to the visible history from the featured receipt',async t=>{
  const h=await createOfflineSubscriptionVisual({after:callback=>t.after(callback)});
  const item=h.initial.history.items[0],receipt=item.receipt??item;
  const page=renderSubscriptionScreen({document:h.document,data:h.initial,receiptPresentation:{receipt,remainingCount:0}});
  h.document.getElementById('screen').replaceChildren(page);
  const history=page.querySelector('.subscription-history');assert.equal(history.tagName,'SECTION');assert.equal(history.closest('details'),null);
  [...page.querySelectorAll('button')].find(node=>node.textContent==='Все квитанции').click();
  assert.equal(history.getAttribute('tabindex'),'-1');
  assert.equal(h.document._visualFocused,history);assert.deepEqual(financialPosts(h),[]);
});

test('Back and Escape restore the original action even when the fresh GET blurs its disabled button',async t=>{
  for(const state of ['cancel-confirmation','enable-confirmation','purchase']) {
    const h=await createOfflineSubscriptionVisual({state,simulateFocusedButtonBlur:true,after:callback=>t.after(callback)});
    const selector=state==='purchase'?'[data-recurring-plan="professional"]':`[data-renewal-action="${state==='cancel-confirmation'?'cancel':'enable'}"]`;
    const original=h.document.querySelector(selector),dialog=h.document.querySelector('.subscription-dialog');
    assert.equal(h.focusedButtonBlurCount,1,'the actual fresh check temporarily disables and blurs the invoker');
    assert.notEqual(h.document.activeElement,original);assert.deepEqual(financialPosts(h),[]);
    if(state==='enable-confirmation'){const event=new h.window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:'Escape'});dialog.dispatchEvent(event);}
    else [...dialog.querySelectorAll('button')].find(node=>node.textContent==='Назад').click();
    assert.equal(h.document.querySelector('.subscription-dialog'),null);assert.equal(h.document.activeElement,original);
    assert.equal(original.disabled,false);assert.deepEqual(financialPosts(h),[]);
  }
});
