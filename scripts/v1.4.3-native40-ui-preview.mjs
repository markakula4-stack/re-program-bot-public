// Offline visual evidence only: genuine local authorization/payment fixtures,
// actual cabinet modules and canonical CSS. No production/provider credentials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import os from 'node:os';
import {cabinetSubscriptionFixture, invoiceIntent} from '../tests/helpers/v1.4.3-subscription-cabinet-fixture.mjs';
import {readSubscriptionData} from '../src/v1.4.2/subscription-read-model.mjs';
import {runtimeAuthorizationDTO} from '../src/v1.4.1/runtime-authorizer.mjs';
import {authorizeOwnStarsSubscriptionCommand} from '../src/v1.4.3/subscription-action-authority.mjs';
import {issueStarsRecurringInvoice, requestOwnStarsSubscriptionCommand} from '../src/v1.4.3/telegram-subscription-provider.mjs';
import {handleStarsPreCheckoutQuery, recordStarsSuccessfulPayment} from '../src/v1.3.6/stars-payment-runtime.mjs';
import {applyStarsPaidAccess} from '../src/v1.3.6/stars-access-runtime.mjs';
import {MiniAppClient} from '../src/v1.4.0-rebuild/mini-app/cabinet-client.mjs';
import {mountCabinet} from '../src/v1.4.0-rebuild/mini-app/cabinet-view.mjs';

const requireDom=createRequire(process.env.CABINET_UI_DOM_ROOT
  ?`${process.env.CABINET_UI_DOM_ROOT}/package.json`:new URL('../tests/p08-ui/package.json',import.meta.url));
const {parseHTML}=requireDom('linkedom');
const html=fs.readFileSync(new URL('../src/v1.4.0-rebuild/mini-app/partner-cabinet.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const features={version:1,mutationsEnabled:false,offerActionsEnabled:false,nativeOwnerInvoiceOnly:true,existingRenewalCancellationEnabled:true};

export async function createOfflineSubscriptionVisual({state='current',after=()=>{},simulateFocusedButtonBlur=false}={}) {
  const cleanup=[];
  const f=cabinetSubscriptionFixture({after:callback=>cleanup.push(callback)});
  f.now=Math.floor(Date.now()/1000);
  const providerCalls=[];
  const localProvider=async(_env,method,payload)=>{providerCalls.push({method,payload});return true;};
  const actualNow=Date.now;Date.now=()=>f.now*1000;
  try {
  if(state!=='purchase') {
    const invoice=await issueStarsRecurringInvoice(await f.auth({operation:'billing.purchase_monthly',
      payload:{...invoiceIntent,requestedPlanCode:'professional'}}),{telegramApi:async()=> 'https://t.me/$offlineVisualFixture'});
    const order=f.sqlite.prepare('SELECT * FROM subscription_orders WHERE order_id=?').get(invoice.orderId);
    await handleStarsPreCheckoutQuery(f.serverEnv,{update_id:1439001,pre_checkout_query:{id:'offline-visual-checkout',
      from:{id:101,is_bot:false},currency:'XTR',total_amount:order.amount_stars,invoice_payload:order.invoice_payload}},
      {telegramApi:async()=>true});
    const record=await recordStarsSuccessfulPayment(f.serverEnv,f.successful(order));
    await applyStarsPaidAccess(f.serverEnv,{orderId:record.orderId});
    if(['canceled','permission','enable-confirmation'].includes(state)) {
      const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
      await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.auth({
        payload:{subscriptionAction:'cancel_renewal',contractId:contract.contract_id,expectedRevision:contract.revision}})),{telegramApi:localProvider});
      f.now++;
    }
    if(state==='permission') {
      const contract=f.sqlite.prepare('SELECT * FROM subscription_billing_contracts WHERE contract_id=?').get(invoice.contractId);
      await requestOwnStarsSubscriptionCommand(await authorizeOwnStarsSubscriptionCommand(await f.auth({
        payload:{subscriptionAction:'reenable_renewal',contractId:contract.contract_id,expectedRevision:contract.revision}})),{telegramApi:localProvider});
      f.now++;
    }
  }
  } finally {Date.now=actualNow;}
  let activeReads=0;
  const descriptor=async()=>{activeReads++;try {const authorization=await f.auth();return {...await readSubscriptionData({authorization}),
    authorization:runtimeAuthorizationDTO(authorization),features};} finally {activeReads--;}};
  const initial=await descriptor(),profileAuthorization=runtimeAuthorizationDTO(await f.auth({operation:'profile.read_own'}));
  const bootstrap={readModelVersion:1,authorization:profileAuthorization,features,systemRole:'user',
    partner:{state:'no_application',application:null,profile:null,legalProfile:null,beta:null,actions:{}},
    navigation:['profile','offers','applications','analytics','subscription'].map(section=>({section,enabled:section!=='analytics',reason:null})),
    counts:{visibleOffers:0,ownOffers:0,ownApplications:0,attributedApplications:0}};
  const calls=[],values=new Map();let app,visualDocument=null,focusedButtonBlurCount=0;
  // Mark historical receipt seen so these fixtures inspect subscription
  // controls rather than the independent first-payment receipt presentation.
  const receiptSeen=JSON.stringify(initial.history.items.map(item=>item.receiptId));
  const client=new MiniAppClient({origin:'https://offline-visual.example',now:()=>f.now*1000,
    pendingStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)},
    fetchImpl:async(url,init)=>{calls.push({url,init});
      if(url.endsWith('/session')) return Response.json({sessionToken:'rpms1_'+'a'.repeat(43),tokenType:'Bearer',
        expiresAt:f.now+300,principal:{telegramId:101,botId:123456789},authorizationVersion:1,features});
      if(init.method!=='GET') throw new Error('offline_visual_producer_forbidden');
      if(simulateFocusedButtonBlur&&visualDocument?._visualFocused?.disabled){
        visualDocument._visualFocused=visualDocument.body;focusedButtonBlurCount++;
      }
      return Response.json(url.endsWith('/bootstrap')?bootstrap:await descriptor());
    }});
  await client.authenticate('offline-visual-session');
  const {document,window}=parseHTML(html);visualDocument=document;window.location={hash:'#subscription'};
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>document._visualFocused??document.body});
  window.localStorage={getItem:key=>key==='re-subscription-receipt-seen-v1'?receiptSeen:null,setItem(){}};
  window.HTMLElement.prototype.focus=function(){document._visualFocused=this;};
  window.HTMLElement.prototype.reportValidity=function(){return true;};
  app=mountCabinet({document,client});await app.start();
  const flush=async()=>{for(let i=0;i<16;i++)await tick();
    for(let i=0;activeReads>0&&i<2000;i++)await new Promise(resolve=>setTimeout(resolve,2));
    if(activeReads)throw new Error('offline_visual_reads_unsettled');for(let i=0;i<16;i++)await tick();};
  if(['cancel-confirmation','enable-confirmation','purchase'].includes(state)) {
    const selector=state==='purchase'?'[data-recurring-plan="professional"]':`[data-renewal-action="${state==='cancel-confirmation'?'cancel':'enable'}"]`;
    const control=document.querySelector(selector);
    if(!control||control.disabled) throw new Error('offline_visual_control_unavailable:'+state);
    control.focus();control.click();await flush();
    if(!document.querySelector('[data-subscription-confirmation]')) throw new Error('offline_visual_confirmation_unavailable:'+state+':'+document.getElementById('notice').textContent);
  }
  const close=()=>{app.destroy();for(const callback of cleanup)callback();};after(close);
  return {document,window,app,client,f,initial,calls,providerCalls,flush,close,get focusedButtonBlurCount(){return focusedButtonBlurCount;}};
}

export async function writeOfflineSubscriptionVisuals(directory) {
  fs.mkdirSync(directory,{recursive:true});
  const base=new URL('../src/v1.4.0-rebuild/mini-app/',import.meta.url);
  const css=['partner-cabinet.css','subscription-view.css'].map(name=>fs.readFileSync(new URL(name,base),'utf8')).join('\n');
  const sources=['subscription-view.mjs','subscription-view.css','cabinet-view.mjs','cabinet-client.mjs','telegram-actions-view.mjs','partner-cabinet.css','partner-cabinet.html'];
  const hashes=Object.fromEntries(sources.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(new URL(name,base))).digest('hex')]));
  const manifest={status:'OFFLINE_SYNTHETIC_ACTUAL_UI',sourceSha:process.env.GITHUB_SHA??null,workflowRunId:process.env.GITHUB_RUN_ID??null,
    sourceHashes:hashes,widths:[320,360,390,430],themes:['light','dark'],states:['current','canceled','permission','cancel-confirmation','enable-confirmation','purchase','purchase-terms','native-extras','current-details','history-expanded'],files:[]};
  for(const state of manifest.states) {
    const h=await createOfflineSubscriptionVisual({state:state==='purchase-terms'?'purchase':state});
    try {
      const document=h.document;
      document.querySelectorAll('script, link[rel="stylesheet"]').forEach(node=>node.remove());
      document.documentElement.removeAttribute('data-launch-state');
      document.head.append(document.createElement('style'));document.head.lastChild.textContent=css;
      const nativeDialog=document.querySelector('dialog');nativeDialog?.removeAttribute('open');
      if(state==='purchase-terms')nativeDialog?.querySelector('details.subscription-terms')?.setAttribute('open','');
      if(state==='native-extras')document.querySelector('.subscription-telegram-details')?.setAttribute('open','');
      if(state==='current-details')document.querySelector('.subscription-current-details')?.setAttribute('open','');
      if(state==='history-expanded'){document.querySelector('.subscription-history')?.setAttribute('open','');
        document.querySelector('.subscription-history .subscription-receipt')?.setAttribute('open','');}
      const baseHTML=document.toString();
      for(const theme of manifest.themes) for(const width of manifest.widths) {
        const {document:out}=parseHTML(baseHTML);out.documentElement.setAttribute('data-color-theme',theme);
        out.documentElement.setAttribute('data-visual-state',state);
        const script=out.createElement('script');script.textContent=`
          const dialog=document.querySelector('dialog');if(dialog){dialog.showModal();dialog.querySelector('[data-subscription-confirmation]').focus({preventScroll:true});}
          else {const scrollTarget=${JSON.stringify(state==='native-extras'?'.subscription-telegram-details':state==='history-expanded'?'.subscription-history':state==='current-details'?'.subscription-current':'#screen')};
            window.scrollTo(0,Math.max(0,document.querySelector(scrollTarget).getBoundingClientRect().top+scrollY-18));}
          const measure=()=>{
            const visible=node=>!!(node.offsetWidth||node.offsetHeight||node.getClientRects().length);
            const targets=[...document.querySelectorAll('button:not(:disabled), a[href], summary, .subscription-consent')].filter(visible);
            const badTargets=targets.filter(node=>node.getBoundingClientRect().height<43.5).map(node=>({text:node.textContent,height:node.getBoundingClientRect().height}));
            const current=document.querySelector('.subscription-current')?.getBoundingClientRect();
            const report={state:${JSON.stringify(state)},theme:${JSON.stringify(theme)},requestedWidth:${width},width:innerWidth,height:innerHeight,
              scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,currentCardHeight:current?.height,
              nativeFeatureHeadings:[...document.querySelectorAll('.subscription-telegram-details .subscription-card >h3')].filter(visible).map(node=>node.textContent),
              badTargets,dialog:dialog?{width:dialog.getBoundingClientRect().width,height:dialog.getBoundingClientRect().height,
                left:dialog.getBoundingClientRect().left,right:dialog.getBoundingClientRect().right,top:dialog.getBoundingClientRect().top,bottom:dialog.getBoundingClientRect().bottom,scrollHeight:dialog.scrollHeight,clientHeight:dialog.clientHeight,focusInside:dialog.contains(document.activeElement),modal:dialog.matches(':modal')}:null};
            let pre=document.getElementById('visual-geometry');if(!pre){pre=document.createElement('pre');pre.id='visual-geometry';pre.hidden=true;document.body.append(pre);}
            pre.textContent=JSON.stringify(report);return report;
          };window.__measureUi=measure;measure();`;
        out.body.append(script);
        const filename=`${state}-${theme}-${width}.html`;fs.writeFileSync(path.join(directory,filename),out.toString());manifest.files.push(filename);
      }
    } finally {h.close();}
  }
  fs.writeFileSync(path.join(directory,'UI-VISUAL-MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
// Chrome's local DevTools pipe uses no socket or browser account. It also
// preserves the offline network guard installed before this module. Explicit
// device metrics prove the viewport instead of trusting window-size hints.
export async function renderOfflineSubscriptionVisuals(directory,chrome) {
  if(!fs.existsSync(chrome))throw new Error('actual_chrome_renderer_unavailable');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'UI-VISUAL-MANIFEST.json'),'utf8'));
  if(manifest.status!=='OFFLINE_SYNTHETIC_ACTUAL_UI'||manifest.files.length!==80)throw new Error('offline_visual_manifest_invalid');
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'re-ui-render-'));
  const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check',
    '--host-resolver-rules=MAP * ~NOTFOUND','--hide-scrollbars','--remote-debugging-pipe',`--user-data-dir=${profile}`],
    {stdio:['ignore','ignore','ignore','pipe','pipe']});
  const write=child.stdio[3],read=child.stdio[4],decoder=new StringDecoder('utf8'),pending=new Map();let id=0,buffer='',ended=false;
  const rejectAll=error=>{ended=true;for(const value of pending.values()){clearTimeout(value.timer);value.reject(error);}pending.clear();};
  child.on('error',rejectAll);child.on('exit',code=>rejectAll(new Error('actual_chrome_exited:'+code)));
  read.on('data',chunk=>{buffer+=decoder.write(chunk);let end;
    while((end=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;
      const message=JSON.parse(raw),waiting=pending.get(message.id);if(!waiting)continue;
      pending.delete(message.id);clearTimeout(waiting.timer);
      if(message.error)waiting.reject(new Error('actual_chrome_protocol:'+JSON.stringify(message.error)));else waiting.resolve(message.result);
    }
  });
  const call=(method,params={},sessionId=null)=>new Promise((resolve,reject)=>{
    if(ended){reject(new Error('actual_chrome_pipe_closed'));return;}
    const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('actual_chrome_timeout:'+method));},10000);
    pending.set(requestId,{resolve,reject,timer});write.write(JSON.stringify({id:requestId,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
  const reports=[];let browser=null;
  const save=(status,error=null)=>{
    fs.writeFileSync(path.join(directory,'UI-VISUAL-GEOMETRY.json'),JSON.stringify(reports,null,2)+'\n');
    fs.writeFileSync(path.join(directory,'UI-VISUAL-BROWSER.json'),JSON.stringify({status,browser,sourceSha:manifest.sourceSha,
      workflowRunId:manifest.workflowRunId,frames:reports.length,error},null,2)+'\n');
  };
  try {
    browser=await call('Browser.getVersion');
    const target=await call('Target.createTarget',{url:'about:blank'});
    const attached=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true}),session=attached.sessionId;
    await call('Page.enable',{},session);await call('Runtime.enable',{},session);
    await call('Page.bringToFront',{},session);
    for(const filename of manifest.files) {
      if(!/^[a-z-]+-(?:dark|light)-(?:320|360|390|430)\.html$/u.test(filename))throw new Error('offline_visual_filename_invalid');
      const width=Number(filename.match(/-(\d+)\.html$/u)[1]);
      await call('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:true},session);
      const url=pathToFileURL(path.join(directory,filename)).href;
      const navigated=await call('Page.navigate',{url},session);if(navigated.errorText)throw new Error('actual_chrome_navigation:'+navigated.errorText);
      let ready=false;
      for(let i=0;i<200;i++) {
        const value=await call('Runtime.evaluate',{expression:`location.href===${JSON.stringify(url)}&&typeof window.__measureUi==='function'`,returnByValue:true},session);
        if(value.exceptionDetails)throw new Error('actual_chrome_script_exception');
        if(value.result?.value===true){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      if(!ready)throw new Error('actual_chrome_document_not_ready:'+filename);
      const measured=await call('Runtime.evaluate',{expression:"Promise.resolve(document.fonts?.ready).then(()=>window.__measureUi())",awaitPromise:true,returnByValue:true},session);
      if(measured.exceptionDetails||!measured.result?.value)throw new Error('actual_chrome_geometry_missing:'+filename);
      const report=measured.result.value;reports.push(report);
      const screenshot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},session);
      fs.writeFileSync(path.join(directory,filename.replace(/\.html$/u,'.png')),Buffer.from(screenshot.data,'base64'));save('IN_PROGRESS_ACTUAL_BROWSER_RENDER');
      if(report.width!==width||report.requestedWidth!==width||report.height!==800||report.scrollWidth>report.clientWidth||report.badTargets.length)
        throw new Error('actual_chrome_geometry_failed:'+JSON.stringify(report));
      if(report.state==='native-extras'&&!['Поделиться своей ссылкой','Значок Dragon в Telegram'].every(title=>report.nativeFeatureHeadings.includes(title)))
        throw new Error('actual_chrome_native_headings_hidden:'+filename);
      const dialog=report.dialog;
      if(dialog&&(dialog.left<0||dialog.right>width||dialog.top<0||dialog.bottom>800||!dialog.focusInside||!dialog.modal))
        throw new Error('actual_chrome_modal_failed:'+JSON.stringify(report));
    }
    save('PASS_ACTUAL_BROWSER_RENDER');console.log(JSON.stringify({status:'PASS_ACTUAL_BROWSER_RENDER',frames:reports.length,browser:browser.product}));
    return {browser,reports};
  } catch(error){save('FAILED_ACTUAL_BROWSER_RENDER',error.message);throw error;}
  finally {
    rejectAll(new Error('actual_chrome_render_finished'));read.destroy();write.destroy();child.kill('SIGTERM');fs.rmSync(profile,{recursive:true,force:true});
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--render') {
    if(!process.argv[3]||!process.argv[4])throw new Error('offline_visual_render_arguments_required');
    await renderOfflineSubscriptionVisuals(process.argv[3],process.argv[4]);
  } else {
    const directory=process.argv[2];if(!directory)throw new Error('offline_visual_directory_required');
    const manifest=await writeOfflineSubscriptionVisuals(directory);console.log(JSON.stringify({status:manifest.status,files:manifest.files.length,sourceHashes:manifest.sourceHashes}));
  }
}
