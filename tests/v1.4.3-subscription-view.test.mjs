import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// Real local Chromium renders the actual customer modules. Only the backend
// data/transport is synthetic; this never claims live Telegram acceptance.
const runtimeRequire=createRequire(new URL('./p11-runtime/package.json',import.meta.url));
const {chromium}=runtimeRequire('playwright');
const requireBuild=createRequire(new URL('./p11-runtime/package.json',import.meta.url));
const esbuild=requireBuild('esbuild');
const browserPath=process.env.P11_BROWSER_PATH;
const output=path.resolve(process.env.V143_CUSTOMER_VISUAL_DIR??'tmp/v143/p04-customer-ui');
const css=fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.css',import.meta.url),'utf8')+'\n'+
  fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/subscription-view.css',import.meta.url),'utf8');
let browser,bundle,sourceHashes;
const errors=[],layouts=[];
test.before(async()=>{
  fs.mkdirSync(output,{recursive:true});
  sourceHashes=Object.fromEntries(['src/v1.4.0-rebuild/mini-app/cabinet-client.mjs','src/v1.4.0-rebuild/mini-app/cabinet-view.mjs',
    'src/v1.4.0-rebuild/mini-app/subscription-view.mjs','src/v1.4.0-rebuild/mini-app/subscription-view.css',
    'src/v1.4.0-rebuild/mini-app/partner-cabinet.css','src/v1.4.0-rebuild/mini-app/telegram-native.mjs',
    'src/v1.4.0-rebuild/mini-app/telegram-actions-view.mjs','tests/helpers/v1.4.3-subscription-ui-fixture.mjs'].map(file=>
      [file,createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  const built=await esbuild.build({stdin:{contents:`
    import {renderSubscriptionScreen} from './src/v1.4.0-rebuild/mini-app/subscription-view.mjs';
    import {mountCabinet} from './src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';
    import {subscriptionUIFixture} from './tests/helpers/v1.4.3-subscription-ui-fixture.mjs';
    window.fixture=subscriptionUIFixture;
    window.render=options=>{
      window.app?.destroy();document.body.replaceChildren();
      const data=window.renderData??subscriptionUIFixture(options??{});window.currentFixture=data;window.actions=0;window.termsReads=0;
      const root=renderSubscriptionScreen({document,data,onRefresh:()=>window.actions++,onRenewalAction:()=>window.actions++,
        onRecurringPurchase:()=>window.termsReads++,actionPending:options?.actionPending===true});
      root.style.padding='16px';document.body.append(root);return root;
    };
    window.mount=async options=>{
      window.app?.destroy();document.body.innerHTML='<div id="cabinet"><div id="notice" role="status"></div><nav id="navigation"></nav><main id="screen" tabindex="-1"></main></div>';
      document.getElementById('screen').style.padding='16px';
      location.hash='#subscription';
      const data=subscriptionUIFixture(options??{});window.currentFixture=data;window.reads=[];window.writes=[];window.changeRevision=false;window.changePrice=false;window.enableResultStatus='confirmed';
      window.client={authenticated:true,canMutate:true,canOpenOffers:false,uncertain:false,expiresAt:Math.floor(Date.now()/1000)+300,subscriptionOutcomePending:false,
        async read(resource){window.reads.push(resource);if(resource==='bootstrap')return {partner:{state:'no_application',legalProfile:null,actions:{}},navigation:[]};
          const fresh=structuredClone(data);if(window.changeRevision)fresh.renewalActions.expectedRevision=2;
          if(window.changePrice)fresh.catalog.recurring.offers[0].amountStars=299;return fresh;},
        async subscriptionAction(kind,payload){window.writes.push({kind,payload});
          if(kind==='enable'){
            const confirmed=window.enableResultStatus==='confirmed';
            if(confirmed){Object.assign(data.lifecycle,{state:'active',renewalState:'unknown',pendingOperations:1,reviewRequired:true,reviewReasons:['provider_reenable_permission_pending']});
              data.access.current.accessState='active';Object.assign(data.renewalActions,{renewalState:'unknown',pendingOperations:1,cancel:{...data.renewalActions.cancel,available:false},enable:{...data.renewalActions.enable,available:false}});}
            return{status:window.enableResultStatus,reenableAllowed:confirmed,cancellationConfirmed:false,providerState:null,paidPeriodChanged:false,accessApplied:false};
          }
          return kind==='invoice'?{status:'confirmed',invoiceUrl:'https://t.me/$offline_view_invoice',accessApplied:false}
            :{status:'confirmed',cancellationConfirmed:true,reenableAllowed:false,providerState:null,paidPeriodChanged:false,accessApplied:false};},
        clearSession(){this.authenticated=false;}};
      window.app=mountCabinet({document,client:window.client});await window.app.start();
    };
  `,resolveDir:process.cwd(),sourcefile:'offline-p04-customer-ui.mjs'},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
  bundle=built.outputFiles[0].text;
  browser=await chromium.launch({headless:true,...(browserPath?{executablePath:browserPath}:{}),args:['--disable-background-networking']});
});
test.after(async()=>{
  fs.writeFileSync(path.join(output,'visual-proof.json'),JSON.stringify({kind:'OFFLINE_CHROMIUM_CUSTOMER_UI',actualModules:true,
    syntheticBackend:true,liveTelegram:false,browser:browser?.version(),sourceHashes,
    bundleSha256:bundle?createHash('sha256').update(bundle).digest('hex'):null,errors,layouts},null,2)+'\n');
  await browser?.close();
});
async function page(t,{width=390,theme='light'}={}) {
  const context=await browser.newContext({viewport:{width,height:844},colorScheme:theme,reducedMotion:'reduce',serviceWorkers:'block'});
  t.after(()=>context.close());
  await context.route('**/*',route=>route.abort('blockedbyclient'));
  await context.routeWebSocket('**/*',socket=>socket.close());
  const p=await context.newPage();p.on('pageerror',error=>errors.push(error.message));
  await p.setContent('<!doctype html><html data-color-theme="'+theme+'"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body></body></html>');
  await p.addScriptTag({content:bundle});return p;
}

const labels={active:'Активна',cancel_at_period_end:'Активна',payment_failed:'Продление не оплачено',expired:'Срок завершён',refunded:'Возврат учтён',chargeback:'Платёж оспорен',suspended:'Доступ приостановлен'};
test('real browser renders all seven server states and preserves paid residue without inventing future charge dates',async t=>{
  const p=await page(t);
  for(const [state,label] of Object.entries(labels)) {
    await p.evaluate(state=>window.render({state}),state);
    const text=await p.locator('.subscription-current').innerText();assert.ok(text.includes(label),state);
    if(state==='cancel_at_period_end')assert.match(text,/Продление\s*Отменено/u,'paid access stays active while renewal is canceled');
    assert.doesNotMatch(text,/Следующее списание.*\d|Следующая оплата.*\d/);
    if(['active','cancel_at_period_end','payment_failed'].includes(state))assert.match(text,/Оплачено до/);
    if(state==='payment_failed')assert.match(text,/Доступ сохранён до конца/);
    if(['expired','refunded','chargeback','suspended'].includes(state))assert.doesNotMatch(text,/Осталось|Оплачено до/);
  }
  await p.evaluate(()=>window.render({billingMode:'prepaid'}));
  assert.equal(await p.locator('[data-renewal-action]').count(),0);assert.match(await p.locator('.subscription-current').innerText(),/Автоматического списания нет/);
  await p.evaluate(()=>{const data=window.fixture({paid:false});data.lifecycle=null;data.access.lifecycle=null;
    Object.assign(data.access.current,{planCode:'free',sourceKind:'preview',accessOverlay:'dragon_preview',previewActive:true,accessState:'trial',durationKind:'finite',expiresAt:data.observedAt+604800,remainingSeconds:604800});
    window.renderData=data;window.render();
  });
  assert.match(await p.locator('.subscription-current').innerText(),/Это не платная подписка Dragon/);
});

test('real browser own history expands safe plain text; retained money stays unproved and history is bounded',async t=>{
  const p=await page(t);await p.evaluate(()=>window.render({paid:false}));
  await p.evaluate(()=>{
    const data=window.currentFixture,retained={...data.history.items[0].receipt,status:'retained',paidPeriod:null,reviewRequired:true};
    data.history.items=[{...retained,receipt:retained}];window.renderData=data;
  });
  await p.evaluate(()=>window.render());
  const receipt=p.locator('.subscription-receipt');await receipt.locator('summary').click();
  assert.match(await receipt.innerText(),/Оплата на проверке/);assert.match(await receipt.innerText(),/Оплаченный период по этой операции не подтверждён/);
  assert.match(await receipt.innerText(),/сама по себе не подтверждает платный доступ/);
  await p.evaluate(()=>{window.renderData.history.items[0].receipt.receiptId='<img src=x onerror=alert(1)>';window.render();});
  assert.equal(await p.locator('img').count(),0);
  await p.evaluate(()=>{window.renderData.history.items=Array.from({length:23},(_,i)=>({...window.renderData.history.items[0],receiptId:'stars-'+i}));window.renderData.history.hasMore=true;window.render();});
  assert.equal(await p.locator('.subscription-receipt').count(),20);assert.match(await p.locator('.subscription-history').innerText(),/последние 20 операций/);
});

test('real browser pending operations disable financial controls while leaving terms, refresh and support usable',async t=>{
  const p=await page(t);await p.evaluate(()=>window.render({actionPending:true}));
  for(const node of await p.locator('[data-renewal-action]').all())assert.equal(await node.isDisabled(),true);
  for(const node of await p.locator('[data-recurring-plan]').all()){
    assert.equal(await node.isEnabled(),true);assert.equal(await node.innerText(),'Посмотреть условия');
  }
  await p.locator('[data-recurring-plan]').first().click();assert.equal(await p.evaluate(()=>window.termsReads),1);
  assert.equal(await p.locator('[data-subscription-confirm]').count(),0,'reading terms alone does not authorize a financial action');
  assert.equal(await p.locator('.subscription-payment-help a').count(),1);assert.match(await p.locator('.subscription-current').innerText(),/не отправляет его повторно/);
  await p.locator('.subscription-screen-head button').click();assert.equal(await p.evaluate(()=>window.actions),1);
});

test('actual mounted customer flow rechecks quote twice, requires unchecked consent and sends one fixed invoice intent',async t=>{
  const p=await page(t);await p.evaluate(()=>window.mount({paid:false}));
  assert.equal(await p.evaluate(()=>window.reads[1]),'subscription');
  await p.locator('[data-recurring-plan="professional"]').click();
  const consent=p.locator('.subscription-consent input'),confirm=p.locator('[data-subscription-confirm]');
  await consent.waitFor();assert.equal(await consent.isChecked(),false);assert.equal(await confirm.isDisabled(),true);
  await consent.check();await confirm.click();
  await p.locator('[data-subscription-invoice] a').waitFor();
  assert.deepEqual(await p.evaluate(()=>window.writes),[{kind:'invoice',payload:{planCode:'professional',recurringConsent:true,termsRevision:'2026-10-03.stars-recurring-v1',priceVersion:1}}]);
  assert.ok(await p.evaluate(()=>window.reads.filter(resource=>resource==='subscription').length>=4));
  assert.equal(await p.locator('[data-subscription-invoice] a').getAttribute('href'),'https://t.me/$offline_view_invoice');
  assert.match(await p.locator('#notice').innerText(),/Доступ пока не изменён/);assert.doesNotMatch(await p.locator('#notice').innerText(),/Оплата прошла|Доступ активирован/);
});

test('actual mounted cancel requires confirmation and rejects changed revision; changed quote requires a fresh choice',async t=>{
  const p=await page(t);await p.evaluate(()=>window.mount());
  await p.locator('[data-renewal-action="cancel"]').click();await p.locator('[data-subscription-confirmation]').waitFor();
  assert.match(await p.locator('[data-subscription-confirmation]').innerText(),/Будущие списания прекратятся\. Оплаченный срок сохранится\. Возврат оформляется отдельно\./u);
  assert.equal(await p.evaluate(()=>window.writes.length),0);await p.evaluate(()=>{window.changeRevision=true;});
  await p.locator('[data-subscription-confirm]').click();await p.locator('[data-subscription-confirmation]').waitFor({state:'detached'});
  assert.equal(await p.evaluate(()=>window.writes.length),0);assert.match(await p.locator('#notice').innerText(),/состояние изменились/);
  await p.evaluate(()=>window.mount({paid:false}));await p.evaluate(()=>{window.changePrice=true;});
  await p.locator('[data-recurring-plan="professional"]').click();
  await p.waitForFunction(()=>document.getElementById('notice').textContent.includes('Условия или состояние изменились'));
  assert.equal(await p.locator('[data-subscription-confirmation]').count(),0);assert.equal(await p.evaluate(()=>window.writes.length),0);
});

test('native reenable permission requires the separate Telegram action across confirmation, refresh and reopen without extending paid access',async t=>{
  const p=await page(t);await p.evaluate(()=>window.mount({state:'cancel_at_period_end'}));
  const paidUntil=await p.evaluate(()=>window.currentFixture.lifecycle.paidUntil);
  const paidFact=await p.locator('.subscription-current .subscription-paid-until').innerText();
  const receipts=await p.evaluate(()=>JSON.stringify(window.currentFixture.history));
  await p.locator('[data-renewal-action="enable"]').click();
  const confirmation=p.locator('[data-subscription-confirmation]');await confirmation.waitFor();
  assert.match(await confirmation.innerText(),/включите подписку самостоятельно: Telegram → Звёзды → Мои подписки/u);
  assert.match(await confirmation.innerText(),/Это не новая оплата; оплаченный срок сохранится/u);
  assert.equal(await p.evaluate(()=>window.writes.length),0);
  await p.locator('[data-subscription-confirm]').click();
  const guidance=p.locator('[data-native-renewal-permission="pending"]');await guidance.waitFor();
  assert.match(await p.locator('#notice').innerText(),/Разрешение получено.*В разделе Stars в Telegram включите продление.*Статус включения ещё не подтверждён/u);
  assert.match(await guidance.innerText(),/Проверьте продление: Telegram → Звёзды → Мои подписки/u);
  assert.match(await p.locator('.subscription-current').innerText(),/Разрешение не включает автопродление за вас\. Его состояние ещё не подтверждено; оплаченный срок не изменился/u);
  assert.doesNotMatch(await p.locator('.subscription-current').innerText(),/Продление\s*Автоматическое|новый оплаченный период добавлен/);
  assert.equal(await p.locator('.subscription-current .subscription-paid-until').innerText(),paidFact);
  assert.equal(await p.evaluate(()=>window.currentFixture.lifecycle.paidUntil),paidUntil);
  assert.equal(await p.evaluate(()=>JSON.stringify(window.currentFixture.history)),receipts);
  assert.equal(await p.locator('[data-renewal-action="enable"]').count(),0);
  assert.equal(await guidance.locator('a').count(),0,'no invented native subscription deeplink');
  await guidance.locator('button').click();await guidance.waitFor();assert.equal(await p.evaluate(()=>window.writes.length),1,'refresh does not resend permission or create a payment');
  await p.evaluate(()=>{window.renderData=structuredClone(window.currentFixture);window.render();});
  await guidance.waitFor();assert.match(await guidance.innerText(),/Проверьте продление: Telegram → Звёзды → Мои подписки/u);
  assert.equal(await p.locator('.subscription-current .subscription-paid-until').innerText(),paidFact);
  for(const [width,theme] of [[390,'light'],[390,'dark'],[1100,'light']]){
    await p.setViewportSize({width,height:844});await p.evaluate(theme=>document.documentElement.setAttribute('data-color-theme',theme),theme);
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'native guidance fits '+width);
    await p.screenshot({path:path.join(output,'subscription-native-permission-'+theme+'-'+width+'.png'),fullPage:true});
    await p.locator('.subscription-current').screenshot({path:path.join(output,'subscription-native-permission-card-'+theme+'-'+width+'.png')});
  }
  await p.evaluate(()=>{Object.assign(window.renderData.lifecycle,{renewalState:'active',pendingOperations:0,reviewRequired:false,reviewReasons:[]});window.render();});
  assert.equal(await p.locator('[data-native-renewal-permission]').count(),0,'only a fresh server projection confirms renewal');
  assert.match(await p.locator('.subscription-current').innerText(),/Продление\s*Автоматическое/);
  assert.equal(await p.locator('.subscription-current .subscription-paid-until').innerText(),paidFact);
});

test('permission waiting preserves expired access and unrelated review warnings; rejected and unknown commands never claim permission',async t=>{
  const p=await page(t);
  await p.evaluate(()=>{const data=window.fixture({state:'expired',paid:false});
    Object.assign(data.lifecycle,{renewalState:'unknown',pendingOperations:1,reviewRequired:true,reviewReasons:['provider_reenable_permission_pending','control_order_ambiguous']});
    window.renderData=data;window.render();});
  const current=await p.locator('.subscription-current').innerText();
  assert.match(current,/Срок завершён/);assert.match(current,/Состояние продления требует проверки/);
  assert.doesNotMatch(current,/Оплаченный доступ|Оплачено до|Осталось/);
  assert.ok(await p.evaluate(()=>window.currentFixture.lifecycle.paidUntil<window.currentFixture.observedAt));
  for(const status of ['rejected','unknown']){
    await p.evaluate(()=>window.mount({state:'cancel_at_period_end'}));await p.evaluate(status=>{window.enableResultStatus=status;},status);
    await p.locator('[data-renewal-action="enable"]').click();await p.locator('[data-subscription-confirm]').click();
    await p.locator('[data-subscription-confirmation]').waitFor({state:'detached'});
    assert.doesNotMatch(await p.locator('#notice').innerText(),/Разрешение получено/);
    assert.equal(await p.locator('[data-native-renewal-permission]').count(),0);
  }
});

test('320/390 light and dark actual UI has no overflow, usable receipt and consent controls; screenshots capture current sources',async t=>{
  for(const width of [320,390])for(const theme of ['light','dark']) {
    const p=await page(t,{width,theme});await p.evaluate(()=>window.mount({paid:false,state:'payment_failed'}));
    await p.locator('.subscription-receipt summary').click();
    const measure=()=>p.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      clipped:[...document.querySelectorAll('.subscription-page .button,.subscription-receipt,.subscription-facts')].filter(node=>node.getBoundingClientRect().right>innerWidth+1||node.getBoundingClientRect().left<-1).length}));
    const base=await measure();assert.ok(base.scrollWidth<=width+1,JSON.stringify(base));assert.equal(base.clipped,0);
    await p.screenshot({path:path.join(output,`subscription-${theme}-${width}.png`),fullPage:true});
    await p.locator('[data-recurring-plan="professional"]').click();await p.locator('.subscription-consent input').waitFor();
    const dialog=await measure();assert.ok(dialog.scrollWidth<=width+1);assert.equal(dialog.clipped,0);
    const checkbox=await p.locator('.subscription-consent input').boundingBox();assert.ok(checkbox.width>=20&&checkbox.height>=20);
    await p.screenshot({path:path.join(output,`subscription-consent-${theme}-${width}.png`),fullPage:true});
    layouts.push({width,theme,base,dialog});await p.close();
  }
  assert.deepEqual(errors,[]);
});
